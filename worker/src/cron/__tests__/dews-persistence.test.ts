import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  persistDewsResults,
  reconcileDailyDewsHistorySnapshot,
} from "../dews/persistence";
import type { DewsComputedRow } from "../dews/contracts";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";

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

function makeDewsPersistenceDb(options: {
  currentGenerationRows?: number;
  latestGenerationRows?: number;
  latestTableMissing?: boolean;
} = {}) {
  const currentGenerationRows = options.currentGenerationRows ?? 1;
  const latestGenerationRows = options.latestGenerationRows ?? 1;
  return mockD1([
    {
      match: "pharos:dews:stress-current-generation-count",
      rows: [{ cnt: currentGenerationRows }],
      first: { cnt: currentGenerationRows },
    },
    {
      match: "pharos:dews:stress-latest-generation-count",
      rows: [{ cnt: latestGenerationRows }],
      first: { cnt: latestGenerationRows },
      throwError: options.latestTableMissing ? new Error("no such table: stress_signals_latest") : undefined,
    },
    {
      match: "pharos:dews:stress-history-daily-ids",
      rows: [{ stablecoin_id: "usdt-tether" }],
    },
    ...(options.latestTableMissing
      ? [{
          match: "stress_signals_latest",
          rows: [],
          throwError: new Error("no such table: stress_signals_latest"),
        }]
      : []),
  ]);
}

function openDailyHistoryDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE stress_signal_history (
      stablecoin_id TEXT NOT NULL,
      snapshot_date INTEGER NOT NULL,
      score REAL NOT NULL,
      band TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      PRIMARY KEY (stablecoin_id, snapshot_date)
    );
  `);
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

describe("persistDewsResults", () => {
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

  it("upserts stress_signals_latest alongside current stress rows", async () => {
    const db = makeDewsPersistenceDb();

    const result = await persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(true);
    const pointerWrite = history.find((entry) => entry.binds.includes("dews:published-generation"));
    expect(JSON.parse(String(pointerWrite?.binds[1]))).toMatchObject({
      coverageVersion: 2,
      expectedRowCount: 1,
      stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdt-tether"]),
    });
    expect(result).toMatchObject({
      currentGenerationRows: 1,
      latestGenerationRows: 1,
      publicationPointerWritten: true,
      publishedGeneration: 1_800_000_000,
    });
  });

  it("keeps current stress persistence safe when the latest table is absent", async () => {
    const db = makeDewsPersistenceDb({ latestTableMissing: true });

    await expect(persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    })).resolves.toEqual(expect.objectContaining({ rowsRetiredCurrent: 0 }));

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(true);
  });

  it("writes the publication pointer but skips the freshness sentinel when the run is degraded", async () => {
    const db = makeDewsPersistenceDb();

    await persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: false,
      nowSec: 1_800_000_000,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });

  it("does not publish freshness when the signal aborts after current-row writes", async () => {
    const db = makeDewsPersistenceDb();
    const originalBatch = db.batch.bind(db);
    const controller = new AbortController();
    const abortError = new Error("cron timed out");
    let batchCalls = 0;

    db.batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const result = await originalBatch<T>(statements);
      batchCalls++;
      if (batchCalls === 1) {
        controller.abort(abortError);
      }
      return result;
    };

    await expect(
      persistDewsResults({
        db,
        results: [buildDewsRow("usdt-tether")],
        eligibleIds: new Set(["usdt-tether"]),
        publishFreshnessSentinel: true,
        nowSec: 1_800_000_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cron timed out");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-current-upsert"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("pharos:dews:stress-latest-upsert"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });

  it("does not publish the pointer when the current generation row count is incomplete", async () => {
    const db = makeDewsPersistenceDb({ currentGenerationRows: 0 });

    await expect(persistDewsResults({
      db,
      results: [buildDewsRow("usdt-tether")],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    })).rejects.toThrow("DEWS publication incomplete");

    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("surface_publication_generations"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });

  it("skips the freshness sentinel when no DEWS rows were written", async () => {
    const db = mockD1();

    await persistDewsResults({
      db,
      results: [],
      eligibleIds: new Set(["usdt-tether"]),
      publishFreshnessSentinel: true,
      nowSec: 1_800_000_000,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("dews:published-generation"))).toBe(false);
    expect(history.some((entry) => entry.binds.includes("freshness:dews"))).toBe(false);
  });
});
