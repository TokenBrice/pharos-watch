import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  persistDewsResults,
  reconcileDailyDewsHistorySnapshot,
} from "../../lib/dews/persistence";
import type { DewsComputedRow } from "../../lib/dews/contracts";
import { buildDewsStablecoinIdsDigest, readDewsPublishedGenerationResult } from "../../lib/dews-publication-pointer";
import { loadPublishedStressSignalGeneration } from "../../lib/stress-signals-current-rows";
import { handleStressSignals } from "../../api/stress-signals";
import { loadPublicationHealth } from "../../lib/publication-contract";
import { StressSignalsAllResponseSchema } from "@shared/types/market";

function buildDewsRow(stablecoinId: string): DewsComputedRow {
  return {
    stablecoinId,
    score: 12,
    band: "CALM",
    signals: { supply: { value: 10, available: true, weight: 1 } },
    amplifiers: { psi: 1, contagion: 1 },
    baseScore: 12,
    finalScore: 12,
    availableWeight: 1,
    effectiveWeights: { supply: 1 },
    evidenceKinds: ["supply"],
    insufficientEvidenceReason: null,
    dataQualityScore: 1,
    topContributors: [],
  } as unknown as DewsComputedRow;
}

function openDailyHistoryDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

function insertDailyHistoryRow(sqlite: DatabaseSync, stablecoinId: string, snapshotDate: number): void {
  sqlite.prepare(
    `INSERT INTO stress_signal_history
       (stablecoin_id, snapshot_date, score, band, signals_json)
     VALUES (?, ?, 1, 'CALM', '{}')`,
  ).run(stablecoinId, snapshotDate);
}

function readDailyHistoryIds(sqlite: DatabaseSync, snapshotDate: number): string[] {
  return (sqlite.prepare(
    "SELECT stablecoin_id FROM stress_signal_history WHERE snapshot_date = ? ORDER BY stablecoin_id",
  ).all(snapshotDate) as Array<{ stablecoin_id: string }>).map((row) => row.stablecoin_id);
}

function readDewsRows(
  sqlite: DatabaseSync,
  table: "stress_signals" | "stress_signals_latest",
  computedAt?: number,
): Array<{ stablecoinId: string; computedAt: number; score: number }> {
  const predicate = computedAt == null ? "" : "WHERE computed_at = ?";
  return sqlite
    .prepare(`SELECT stablecoin_id, computed_at, score FROM ${table} ${predicate} ORDER BY stablecoin_id`)
    .all(...(computedAt == null ? [] : [computedAt]))
    .map((row) => ({
      stablecoinId: String(row.stablecoin_id),
      computedAt: Number(row.computed_at),
      score: Number(row.score),
    }));
}

async function observeDewsPublication(sqlite: DatabaseSync, db: D1Database, nowSec: number) {
  const pointer = await readDewsPublishedGenerationResult(db, nowSec);
  const published = await loadPublishedStressSignalGeneration(db, nowSec);
  const apiResponse = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
  const response = StressSignalsAllResponseSchema.parse(await apiResponse.json());
  const health = (await loadPublicationHealth(db, nowSec)).surfaces.dews;
  const ledger = sqlite
    .prepare(
      `SELECT generation_id, state, published_rows, expected_rows, artifact_checksum
       FROM surface_publication_generations
      WHERE surface = 'dews'
      ORDER BY started_at`,
    )
    .all()
    .map((row) => ({
      generationId: String(row.generation_id),
      state: String(row.state),
      publishedRows: Number(row.published_rows),
      expectedRows: Number(row.expected_rows),
      checksum: String(row.artifact_checksum),
    }));
  const freshness = sqlite.prepare("SELECT updated_at FROM cache WHERE key = 'freshness:dews'").get() as
    { updated_at: number } | undefined;

  return {
    pointer,
    published,
    current: readDewsRows(sqlite, "stress_signals"),
    latest: readDewsRows(sqlite, "stress_signals_latest"),
    api: { status: apiResponse.status, updatedAt: response.updatedAt, stablecoinIds: Object.keys(response.signals).sort() },
    ledger,
    health: health && {
      published: health.lastPublishedGeneration?.generationId,
      attempted: health.lastAttemptedGeneration?.generationId,
    },
    freshnessAt: freshness?.updated_at ?? null,
  };
}

describe("persistDewsResults", () => {
  it("surfaces a missing mandatory latest-signal table", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.exec("DROP TABLE stress_signals_latest");
      await expect(
        persistDewsResults({
          db,
          results: [buildDewsRow("usdt-tether")],
          eligibleIds: new Set(["usdt-tether"]),
          publishFreshnessSentinel: true,
          nowSec: Math.floor(Date.now() / 1000),
        }),
      ).rejects.toThrow("no such table: stress_signals_latest");
    } finally {
      sqlite.close();
    }
  });

  it("replaces count-equal swaps and shrinkage with the exact daily identity set", async () => {
    const { sqlite, db } = openDailyHistoryDb();
    const snapshotDate = 1_800_000_000;
    const frozenId = [...FROZEN_IDS][0];
    try {
      insertDailyHistoryRow(sqlite, "usdt-tether", snapshotDate);
      insertDailyHistoryRow(sqlite, "stale-coin", snapshotDate);
      if (frozenId) insertDailyHistoryRow(sqlite, frozenId, snapshotDate);

      await expect(reconcileDailyDewsHistorySnapshot(
        db,
        [buildDewsRow("usdt-tether"), buildDewsRow("usdc-circle")],
        snapshotDate,
      )).resolves.toMatchObject({
        rewritten: true,
        previousOwnedRowCount: 2,
        sealedRowCount: 2,
      });
      expect(readDailyHistoryIds(sqlite, snapshotDate)).toEqual(
        ["usdt-tether", "usdc-circle", ...(frozenId ? [frozenId] : [])].sort(),
      );

      await expect(reconcileDailyDewsHistorySnapshot(
        db,
        [buildDewsRow("usdc-circle")],
        snapshotDate,
      )).resolves.toMatchObject({
        rewritten: true,
        previousOwnedRowCount: 2,
        sealedRowCount: 1,
      });
      expect(readDailyHistoryIds(sqlite, snapshotDate)).toEqual(
        ["usdc-circle", ...(frozenId ? [frozenId] : [])].sort(),
      );
    } finally {
      sqlite.close();
    }
  });

  it("rolls back the daily delete when an exact-set replacement insert fails", async () => {
    const { sqlite, db } = openDailyHistoryDb();
    const snapshotDate = 1_800_000_000;
    try {
      insertDailyHistoryRow(sqlite, "legacy-a", snapshotDate);
      insertDailyHistoryRow(sqlite, "legacy-b", snapshotDate);
      sqlite.exec(`
        CREATE TRIGGER fail_daily_history_seal
        BEFORE INSERT ON stress_signal_history
        WHEN NEW.stablecoin_id = 'usdc-circle'
        BEGIN
          SELECT RAISE(ABORT, 'daily history seal failed');
        END;
      `);

      await expect(reconcileDailyDewsHistorySnapshot(
        db,
        [buildDewsRow("usdt-tether"), buildDewsRow("usdc-circle")],
        snapshotDate,
      )).rejects.toThrow("daily history seal failed");
      expect(readDailyHistoryIds(sqlite, snapshotDate)).toEqual(["legacy-a", "legacy-b"]);
    } finally {
      sqlite.close();
    }
  });

  it("publishes complete generations, retains prior freshness on degradation, and rolls back an interrupted publication", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const [baseline, degraded, retry] = [nowSec - 180, nowSec - 120, nowSec - 60];
    const digest = buildDewsStablecoinIdsDigest(["usdt-tether"]);
    const persist = (computedAt: number, publishFreshnessSentinel: boolean) =>
      persistDewsResults({
        db,
        results: [buildDewsRow("usdt-tether")],
        eligibleIds: new Set(["usdt-tether"]),
        publishFreshnessSentinel,
        nowSec: computedAt,
      });

    try {
      await expect(persist(baseline, true)).resolves.toMatchObject({
        currentGenerationRows: 1,
        latestGenerationRows: 1,
        publishedGeneration: baseline,
      });
      const first = await observeDewsPublication(sqlite, db, nowSec);
      expect(first.pointer).toEqual({
        status: "ok",
        computedAt: baseline,
        expectedRowCount: 1,
        stablecoinIdsDigest: digest,
      });
      expect(first.published).toMatchObject({ status: "ok", computedAt: baseline, exactCoverageVerified: true });
      expect(first.current).toEqual([{ stablecoinId: "usdt-tether", computedAt: baseline, score: 12 }]);
      expect(first.latest).toEqual(first.current);
      expect(first.api).toEqual({ status: 200, updatedAt: baseline, stablecoinIds: ["usdt-tether"] });
      expect(first.ledger).toEqual([
        { generationId: `dews:${baseline}`, state: "published", publishedRows: 1, expectedRows: 1, checksum: digest },
      ]);
      expect(first.health).toEqual({ published: `dews:${baseline}`, attempted: `dews:${baseline}` });
      expect(first.freshnessAt).toBe(baseline);

      await expect(persist(degraded, false)).resolves.toMatchObject({ publishedGeneration: degraded });
      const second = await observeDewsPublication(sqlite, db, nowSec);
      expect(second.pointer).toMatchObject({ status: "ok", computedAt: degraded, stablecoinIdsDigest: digest });
      expect(second.api).toEqual({ status: 200, updatedAt: degraded, stablecoinIds: ["usdt-tether"] });
      expect(second.health).toEqual({ published: `dews:${degraded}`, attempted: `dews:${degraded}` });
      expect(second.freshnessAt).toBe(baseline);

      sqlite.exec(`
        CREATE TRIGGER drop_dews_publication_candidate
        AFTER INSERT ON stress_signal_publication_rows
        WHEN NEW.computed_at = ${retry}
        BEGIN
          DELETE FROM stress_signal_publication_rows
           WHERE stablecoin_id = NEW.stablecoin_id AND computed_at = NEW.computed_at;
        END;
      `);
      await expect(persist(retry, true)).rejects.toThrow("DEWS publication incomplete");
      const interrupted = await observeDewsPublication(sqlite, db, nowSec);
      expect(readDewsRows(sqlite, "stress_signals", retry)).toEqual([]);
      expect(interrupted.latest).toEqual([{ stablecoinId: "usdt-tether", computedAt: retry, score: 12 }]);
      expect(interrupted.pointer).toMatchObject({ status: "ok", computedAt: degraded });
      expect(interrupted.ledger.map((row) => row.generationId)).toEqual([`dews:${baseline}`, `dews:${degraded}`]);
      expect(interrupted.api).toEqual({ status: 200, updatedAt: degraded, stablecoinIds: ["usdt-tether"] });
      expect(interrupted.health).toEqual({ published: `dews:${degraded}`, attempted: `dews:${degraded}` });
      expect(interrupted.freshnessAt).toBe(baseline);

      sqlite.exec("DROP TRIGGER drop_dews_publication_candidate");
      await expect(persist(retry, true)).resolves.toMatchObject({ publishedGeneration: retry });
      const recovered = await observeDewsPublication(sqlite, db, nowSec);
      expect(recovered.pointer).toMatchObject({ status: "ok", computedAt: retry, stablecoinIdsDigest: digest });
      expect(recovered.published).toMatchObject({ status: "ok", computedAt: retry, exactCoverageVerified: true });
      expect(recovered.api).toEqual({ status: 200, updatedAt: retry, stablecoinIds: ["usdt-tether"] });
      expect(recovered.ledger[recovered.ledger.length - 1]).toEqual({
        generationId: `dews:${retry}`,
        state: "published",
        publishedRows: 1,
        expectedRows: 1,
        checksum: digest,
      });
      expect(recovered.health).toEqual({ published: `dews:${retry}`, attempted: `dews:${retry}` });
      expect(recovered.freshnessAt).toBe(retry);
    } finally {
      sqlite.close();
    }
  });

  it("skips the publication pointer and freshness sentinel when no DEWS rows were written", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await persistDewsResults({
        db,
        results: [],
        eligibleIds: new Set(["usdt-tether"]),
        publishFreshnessSentinel: true,
        nowSec: Math.floor(Date.now() / 1000),
      });
      expect(
        sqlite.prepare("SELECT key FROM cache WHERE key IN ('dews:published-generation', 'freshness:dews')").all(),
      ).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
