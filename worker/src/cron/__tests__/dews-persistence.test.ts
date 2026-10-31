import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
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
import { computeLiquiditySignal, computeSupplySignal } from "../../lib/dews/signal-families";
import { decodeLegacyStressSignals } from "../../lib/dews/source-state/legacy-bridge";
import { makeDewsInput } from "../../lib/__tests__/dews.test-support";
import { projectDewsBandTransitions } from "../../lib/tape-projectors/dews";

function buildDewsRow(stablecoinId: string, score = 12, band: "CALM" | "WARNING" = "CALM"): DewsComputedRow {
  return {
    stablecoinId,
    score,
    band,
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
    servedScores: Object.fromEntries(Object.entries(response.signals).map(([id, signal]) => [id, signal.score])),
    ledger,
    health: health && {
      published: health.lastPublishedGeneration?.generationId,
      attempted: health.lastAttemptedGeneration?.generationId,
    },
    freshnessAt: freshness?.updated_at ?? null,
  };
}

describe("persistDewsResults", () => {
  it("roundtrips full, partial, unavailable and legacy-unknown composite coverage without rewriting history", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const inputs = {
      "usdt-tether": makeDewsInput({
        mcapUsd: 1e9, circulatingCurrent: 95, circulatingPrevDay: 100, circulatingPrevWeek: 100,
        liquidityScore: 80, liquidityScore7dAgo: 100, tvlCurrent: 75, tvl7dAgo: 100,
      }),
      "usdc-circle": makeDewsInput({
        mcapUsd: 1e9, circulatingCurrent: 95, circulatingPrevDay: 100, circulatingPrevWeekAvailable: false,
        liquidityScore: 80, liquidityScore7dAgo: null, tvlCurrent: 75, tvl7dAgo: 100,
      }),
      "dai-makerdao": makeDewsInput({
        circulatingPrevDayAvailable: false, circulatingPrevWeekAvailable: false,
        liquidityScore: 80, liquidityScore7dAgo: null, tvlCurrent: null, tvl7dAgo: null,
      }),
    };
    const results: DewsComputedRow[] = Object.entries(inputs).map(([id, input]) => ({
      ...buildDewsRow(id), signals: { supply: computeSupplySignal(input), liq: computeLiquiditySignal(input) },
    }));
    const legacy = buildDewsRow("usde-ethena");
    legacy.signals = { supply: { value: 10, available: true }, liq: { value: 0, available: false } };
    results.push(legacy);
    const ids = new Set(results.map((row) => row.stablecoinId));
    const expected = {
      "usdt-tether": { supply: { componentCoverage: 1, delta1d: -5, delta7d: -5 }, liq: { value: 45, componentCoverage: 1 } },
      "usdc-circle": {
        supply: { value: 65, componentCoverage: 0.6, delta1d: -5, delta7d: null },
        liq: { value: 40, componentCoverage: 0.5, scoreDelta7d: null, tvlDelta7d: -25 },
      },
      "dai-makerdao": {
        supply: { available: false, componentCoverage: 0, delta1d: null, delta7d: null },
        liq: { available: false, componentCoverage: 0, scoreDelta7d: null, tvlDelta7d: null },
      },
      "usde-ethena": legacy.signals,
    };
    try {
      await persistDewsResults({ db, results, eligibleIds: ids, degradedSources: [], nowSec });
      await reconcileDailyDewsHistorySnapshot(db, results, nowSec - 86_400);
      for (const table of ["stress_signals", "stress_signals_latest", "stress_signal_publication_rows", "stress_signal_history"]) {
        const rows = sqlite.prepare(`SELECT stablecoin_id, signals_json FROM ${table}`).all();
        expect(rows).toHaveLength(table === "stress_signal_history" ? 8 : 4);
        for (const row of rows) {
          const decoded = decodeLegacyStressSignals(String(row.signals_json), nowSec);
          expect(decoded.ok).toBe(true);
          if (!decoded.ok) throw new Error(decoded.reason);
          expect(decoded.payload).toMatchObject(expected[row.stablecoin_id as keyof typeof expected]);
          if (row.stablecoin_id === "usde-ethena") {
            expect(decoded.payload.supply).not.toHaveProperty("componentCoverage");
            expect(decoded.payload.liq).not.toHaveProperty("componentCoverage");
          }
        }
      }
      const served = StressSignalsAllResponseSchema.parse(await (await handleStressSignals(db, new URL("https://x/api/stress-signals"))).json());
      expect(served.signals["usdc-circle"]?.signals).toMatchObject(expected["usdc-circle"]);
      const history = sqlite.prepare("SELECT * FROM stress_signal_history ORDER BY stablecoin_id").all();
      await persistDewsResults({ db, results, eligibleIds: ids, degradedSources: [], nowSec: nowSec + 60 });
      expect(sqlite.prepare("SELECT * FROM stress_signal_history ORDER BY stablecoin_id").all()).toEqual(history);
    } finally {
      sqlite.close();
    }
  });

  it("updates every latest-row field in place while preserving publication and sparse history clocks", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const ids = ["usdc-circle", "usdt-tether"];
    const persist = (rows: DewsComputedRow[], clock: number) => persistDewsResults({
      db, results: rows, eligibleIds: new Set(ids), degradedSources: [], nowSec: clock,
    });
    try {
      await persist(ids.map((id) => buildDewsRow(id)), nowSec - 120);
      const identity = sqlite.prepare("SELECT rowid FROM stress_signals_latest WHERE stablecoin_id = ?")
        .get(ids[0]!);
      const changed = {
        ...buildDewsRow(ids[0]!, 44), band: "ALERT",
        signals: { supply: { value: 40, available: true, weight: 1 } },
        baseScore: 40, finalScore: 44, sourceAges: { supply: 15 },
      } as DewsComputedRow;
      await persist([changed, buildDewsRow(ids[1]!)], nowSec);
      const latest = sqlite.prepare("SELECT * FROM stress_signals_latest WHERE stablecoin_id = ?").get(ids[0]!)!;
      expect(latest).toEqual({
        stablecoin_id: ids[0], computed_at: nowSec, score: 44, band: "ALERT", updated_at: nowSec,
        signals_json: JSON.stringify({
          signals: changed.signals, amplifiers: changed.amplifiers,
          baseScore: changed.baseScore, finalScore: changed.finalScore,
          effectiveWeights: changed.effectiveWeights, evidenceKinds: changed.evidenceKinds,
          insufficientEvidenceReason: changed.insufficientEvidenceReason,
          dataQualityScore: changed.dataQualityScore, topContributors: changed.topContributors,
          sourceAges: changed.sourceAges,
        }),
      });
      expect(sqlite.prepare("SELECT rowid FROM stress_signals_latest WHERE stablecoin_id = ?").get(ids[0]!))
        .toEqual(identity);
      expect(sqlite.prepare(
        "SELECT computed_at, score FROM stress_signal_publication_rows WHERE stablecoin_id = ? ORDER BY computed_at",
      ).all(ids[0]!)).toEqual([
        { computed_at: nowSec - 120, score: 12 }, { computed_at: nowSec, score: 44 },
      ]);
      expect(sqlite.prepare("SELECT computed_at, score FROM stress_signals WHERE stablecoin_id = ? ORDER BY computed_at")
        .all(ids[0]!)).toEqual([
          { computed_at: nowSec - 120, score: 12 }, { computed_at: nowSec, score: 44 },
        ]);
      // Latest has always been unconditional; pointer CAS remains the authority
      // that prevents an older attempt from becoming the served generation.
      await persist([changed, buildDewsRow(ids[1]!)], nowSec - 60);
      expect(sqlite.prepare("SELECT computed_at, updated_at FROM stress_signals_latest WHERE stablecoin_id = ?")
        .get(ids[0]!)).toEqual({ computed_at: nowSec - 60, updated_at: nowSec - 60 });
      expect(await readDewsPublishedGenerationResult(db, nowSec)).toMatchObject({ computedAt: nowSec });
    } finally {
      sqlite.close();
    }
  });

  it.each(["score", "band", "signals"] as const)("reseals changed identities without rewriting identical rows (%s)", async (field) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const snapshotDate = 1_800_000_000;
    const initial = ["unchanged", "changed", "departed"].map((id) => buildDewsRow(id));
    try {
      await reconcileDailyDewsHistorySnapshot(db, initial, snapshotDate);
      const unchanged = sqlite.prepare("SELECT rowid, * FROM stress_signal_history WHERE stablecoin_id = 'unchanged'").get();
      sqlite.exec(`CREATE TABLE daily_write_audit (operation TEXT NOT NULL, stablecoin_id TEXT NOT NULL);
        CREATE TRIGGER audit_daily_update AFTER UPDATE ON stress_signal_history BEGIN
          INSERT INTO daily_write_audit VALUES ('update', NEW.stablecoin_id); END;
        CREATE TRIGGER audit_daily_delete AFTER DELETE ON stress_signal_history BEGIN
          INSERT INTO daily_write_audit VALUES ('delete', OLD.stablecoin_id); END;
        CREATE TRIGGER audit_daily_insert AFTER INSERT ON stress_signal_history BEGIN
          INSERT INTO daily_write_audit VALUES ('insert', NEW.stablecoin_id); END;`);
      const changed = buildDewsRow("changed");
      if (field === "score") changed.score = 44;
      if (field === "band") changed.band = "ALERT";
      if (field === "signals") changed.signals = { ...changed.signals, supply: { value: 22, available: true } };
      const results = [buildDewsRow("unchanged"), changed, buildDewsRow("new")];
      expect(await reconcileDailyDewsHistorySnapshot(db, results, snapshotDate)).toEqual({
        rewritten: true, previousOwnedRowCount: 3, sealedRowCount: 3,
      });
      expect(readDailyHistoryIds(sqlite, snapshotDate)).toEqual(["changed", "new", "unchanged"]);
      expect(sqlite.prepare("SELECT rowid, * FROM stress_signal_history WHERE stablecoin_id = 'unchanged'").get())
        .toEqual(unchanged);
      expect(sqlite.prepare("SELECT * FROM daily_write_audit ORDER BY operation").all()).toEqual([
        { operation: "delete", stablecoin_id: "departed" },
        { operation: "insert", stablecoin_id: "new" },
        { operation: "update", stablecoin_id: "changed" },
      ]);
      const stored = sqlite.prepare("SELECT score, band, signals_json FROM stress_signal_history WHERE stablecoin_id = 'changed'").get()!;
      expect(stored.score).toBe(changed.score);
      expect(stored.band).toBe(changed.band);
      expect(JSON.parse(String(stored.signals_json)).signals).toEqual(changed.signals);
      // Exact-ID early return is deliberately unchanged: daily values are not
      // refreshed just because a later run computed different same-day scores.
      results[1] = buildDewsRow("changed", 99);
      expect(await reconcileDailyDewsHistorySnapshot(db, results, snapshotDate)).toMatchObject({ rewritten: false });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM daily_write_audit").get()).toEqual({ count: 3 });
    } finally {
      sqlite.close();
    }
  });

  it("keeps daily upserts inside D1's bound limit across multiple statements", async () => {
    const statements: string[] = [];
    const { sqlite, db } = createLatestSchemaSqlite({
      onRun: (sql) => {
        if (sql.includes("stress-history-daily-seal")) statements.push(sql);
      },
    });
    const rows = Array.from({ length: 41 }, (_, index) => buildDewsRow(`coin-${index}`));
    try {
      expect(await reconcileDailyDewsHistorySnapshot(db, rows, 1_800_000_000))
        .toMatchObject({ rewritten: true, sealedRowCount: 41 });
      expect(statements).toHaveLength(3);
      expect(statements.map((sql) => sql.match(/\?/g)?.length)).toEqual([100, 100, 5]);
      expect(readDailyHistoryIds(sqlite, 1_800_000_000)).toHaveLength(41);
    } finally {
      sqlite.close();
    }
  });

  it("quarantines latest rows without erasing history or accepted buffers, then heals", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const ids = ["usdt-tether", "usdc-circle"];
    const baseline = nowSec - 180;
    const quarantined = nowSec - 120;
    const held = nowSec - 60;
    const persist = (computedAt: number, admittedIds: string[], rejectedIds: string[]) =>
      persistDewsResults({
        db,
        results: admittedIds.map((id) => buildDewsRow(id)),
        eligibleIds: new Set(ids),
        quarantinedStablecoinIds: rejectedIds,
        degradedSources: [],
        nowSec: computedAt,
      });
    try {
      await persist(baseline, ids, []);
      const sparseBefore = readDewsRows(sqlite, "stress_signals");
      const dailyBefore = sqlite.prepare("SELECT * FROM stress_signal_history ORDER BY stablecoin_id").all();
      await expect(persist(quarantined, ["usdc-circle"], ["usdt-tether"])).resolves.toMatchObject({
        currentGenerationRows: 1, latestGenerationRows: 1, publicationPointerWritten: true,
      });
      expect(await readDewsPublishedGenerationResult(db, nowSec)).toMatchObject({
        status: "ok", computedAt: quarantined, expectedRowCount: 1,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle"]),
      });
      expect(readDewsRows(sqlite, "stress_signals_latest")).toEqual([
        { stablecoinId: "usdc-circle", computedAt: quarantined, score: 12 },
      ]);
      expect(readDewsRows(sqlite, "stress_signals")).toEqual(sparseBefore);
      expect(sqlite.prepare("SELECT * FROM stress_signal_history ORDER BY stablecoin_id").all()).toEqual(dailyBefore);
      expect(sqlite.prepare(
        "SELECT stablecoin_id FROM stress_signal_publication_rows WHERE computed_at = ? ORDER BY stablecoin_id",
      ).all(baseline)).toEqual(ids.slice().sort().map((stablecoin_id) => ({ stablecoin_id })));

      await expect(persist(held, [], ids)).resolves.toMatchObject({
        publicationPointerWritten: false, publishedGeneration: null,
      });
      expect(readDewsRows(sqlite, "stress_signals_latest")).toEqual([]);
      const published = await loadPublishedStressSignalGeneration(db, nowSec);
      expect(published).toMatchObject({ status: "ok", computedAt: quarantined });
      if (published.status === "ok") expect(published.rows.map((row) => row.stablecoin_id)).toEqual(["usdc-circle"]);
      expect(sqlite.prepare("SELECT * FROM stress_signal_history ORDER BY stablecoin_id").all()).toEqual(dailyBefore);

      await persist(nowSec, ids, []);
      expect(await readDewsPublishedGenerationResult(db, nowSec)).toMatchObject({
        status: "ok", computedAt: nowSec, expectedRowCount: 2,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(ids),
      });
      expect(readDewsRows(sqlite, "stress_signals_latest").map((row) => row.stablecoinId)).toEqual(ids.slice().sort());
    } finally {
      sqlite.close();
    }
  });

  it("preserves quarantined daily rows when the admitted daily identity set changes", async () => {
    const { sqlite, db } = openDailyHistoryDb();
    const snapshotDate = 1_800_000_000;
    try {
      insertDailyHistoryRow(sqlite, "usdt-tether", snapshotDate);
      insertDailyHistoryRow(sqlite, "removed", snapshotDate);
      await reconcileDailyDewsHistorySnapshot(
        db, [buildDewsRow("usdc-circle")], snapshotDate, undefined, new Set(["usdt-tether"]),
      );
      expect(readDailyHistoryIds(sqlite, snapshotDate)).toEqual(["usdc-circle", "usdt-tether"]);
      expect(sqlite.prepare(
        "SELECT score, signals_json FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date = ?",
      ).get("usdt-tether", snapshotDate)).toEqual({ score: 1, signals_json: "{}" });
    } finally {
      sqlite.close();
    }
  });

  it("surfaces a missing mandatory latest-signal table", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.exec("DROP TABLE stress_signals_latest");
      await expect(
        persistDewsResults({
          db,
          results: [buildDewsRow("usdt-tether")],
          eligibleIds: new Set(["usdt-tether"]),
          degradedSources: [],
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

  it("publishes complete generations, withholds a degraded generation, and rolls back an interrupted publication", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const [baseline, degraded, retry] = [nowSec - 180, nowSec - 120, nowSec - 60];
    const digest = buildDewsStablecoinIdsDigest(["usdt-tether"]);
    const persist = (computedAt: number, degradedSources: readonly string[] = []) =>
      persistDewsResults({
        db,
        results: [buildDewsRow("usdt-tether")],
        eligibleIds: new Set(["usdt-tether"]),
        degradedSources,
        nowSec: computedAt,
      });

    try {
      await expect(persist(baseline)).resolves.toMatchObject({
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

      await expect(persist(degraded, ["dex-liquidity-freshness"])).resolves.toMatchObject({
        publicationPointerWritten: false,
        publishedGeneration: null,
      });
      const second = await observeDewsPublication(sqlite, db, nowSec);
      expect(second.pointer).toMatchObject({ status: "ok", computedAt: baseline, stablecoinIdsDigest: digest });
      expect(second.api).toEqual({ status: 200, updatedAt: baseline, stablecoinIds: ["usdt-tether"] });
      expect(second.health).toEqual({ published: `dews:${baseline}`, attempted: `dews:${degraded}` });
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
      await expect(persist(retry)).rejects.toThrow("DEWS publication incomplete");
      const interrupted = await observeDewsPublication(sqlite, db, nowSec);
      expect(readDewsRows(sqlite, "stress_signals", retry)).toEqual([]);
      expect(interrupted.latest).toEqual([{ stablecoinId: "usdt-tether", computedAt: retry, score: 12 }]);
      expect(interrupted.pointer).toMatchObject({ status: "ok", computedAt: baseline });
      expect(interrupted.ledger.map((row) => row.generationId)).toEqual([`dews:${baseline}`, `dews:${degraded}`]);
      expect(interrupted.api).toEqual({ status: 200, updatedAt: baseline, stablecoinIds: ["usdt-tether"] });
      expect(interrupted.health).toEqual({ published: `dews:${baseline}`, attempted: `dews:${degraded}` });
      expect(interrupted.freshnessAt).toBe(baseline);

      sqlite.exec("DROP TRIGGER drop_dews_publication_candidate");
      await expect(persist(retry)).resolves.toMatchObject({ publishedGeneration: retry });
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

  it("keeps serving the previous generation and its score when a weighted source is degraded", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const [published, withheld] = [nowSec - 120, nowSec - 60];
    try {
      await persistDewsResults({
        db,
        results: [buildDewsRow("usdt-tether", 27)],
        eligibleIds: new Set(["usdt-tether"]),
        degradedSources: [],
        nowSec: published,
      });
      await expect(persistDewsResults({
        db,
        results: [buildDewsRow("usdt-tether", 11)],
        eligibleIds: new Set(["usdt-tether"]),
        degradedSources: ["dex-liquidity-freshness"],
        nowSec: withheld,
      })).resolves.toMatchObject({ publicationPointerWritten: false, publishedGeneration: null });

      const observed = await observeDewsPublication(sqlite, db, nowSec);
      expect(observed.pointer).toMatchObject({ status: "ok", computedAt: published });
      expect(observed.api).toEqual({ status: 200, updatedAt: published, stablecoinIds: ["usdt-tether"] });
      expect(observed.servedScores).toEqual({ "usdt-tether": 27 });
      expect(observed.health).toEqual({ published: `dews:${published}`, attempted: `dews:${withheld}` });
      expect(
        sqlite.prepare(
          "SELECT state, failure_reason FROM surface_publication_generations WHERE generation_id = ?",
        ).get(`dews:${withheld}`),
      ).toEqual({ state: "rejected", failure_reason: "degraded-sources:dex-liquidity-freshness" });
    } finally {
      sqlite.close();
    }
  });

  it("keeps an accepted band change in sparse history after a withheld generation", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const published = nowSec - 180;
    const withheld = nowSec - 120;
    const accepted = nowSec - 60;
    const persist = (computedAt: number, score: number, band: "CALM" | "WARNING", degradedSources: string[]) =>
      persistDewsResults({
        db,
        results: [buildDewsRow("usdt-tether", score, band)],
        eligibleIds: new Set(["usdt-tether"]),
        degradedSources,
        nowSec: computedAt,
      });
    try {
      await persist(published, 12, "CALM", []);
      // The withheld run materializes stress_signals_latest with its rejected
      // WARNING; the next accepted generation publishes the same WARNING.
      await expect(persist(withheld, 62, "WARNING", ["dex-liquidity-freshness"]))
        .resolves.toMatchObject({ publicationPointerWritten: false, publishedGeneration: null });
      await expect(persist(accepted, 62, "WARNING", [])).resolves.toMatchObject({
        publicationPointerWritten: true,
        publishedGeneration: accepted,
      });

      // A published band change must leave a history row at its own generation;
      // the public tape only joins published generations.
      expect(sqlite.prepare(
        "SELECT computed_at, score, band FROM stress_signals WHERE stablecoin_id = ? ORDER BY computed_at",
      ).all("usdt-tether")).toEqual([
        { computed_at: published, score: 12, band: "CALM" },
        { computed_at: withheld, score: 62, band: "WARNING" },
        { computed_at: accepted, score: 62, band: "WARNING" },
      ]);
      await expect(projectDewsBandTransitions(db)).resolves.toEqual({ projected: 1, advanced: accepted });
      expect(sqlite.prepare("SELECT type, source_row_id FROM tape_events ORDER BY id").all()).toEqual([
        { type: "dews.escalated", source_row_id: `usdt-tether:${accepted}:WARNING` },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("seeds daily values from the first accepted same-cohort recovery, not the rejected first run", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const persist = (clock: number, score: number, degradedSources: string[] = []) => persistDewsResults({
      db, results: [buildDewsRow("usdt-tether", score)],
      eligibleIds: new Set(["usdt-tether"]), degradedSources, nowSec: clock,
    });
    const daily = () => sqlite.prepare("SELECT stablecoin_id, score FROM stress_signal_history").all();
    try {
      await expect(persist(nowSec - 180, 70, ["yield-rankings-freshness"]))
        .resolves.toMatchObject({ publicationPointerWritten: false });
      expect(daily()).toEqual([]);
      await expect(persist(nowSec - 120, 25)).resolves.toMatchObject({ publicationPointerWritten: true });
      expect(daily()).toEqual([{ stablecoin_id: "usdt-tether", score: 25 }]);
      await persist(nowSec - 60, 80, ["dex-liquidity-freshness"]);
      await persist(nowSec, 40);
      expect(daily()).toEqual([{ stablecoin_id: "usdt-tether", score: 25 }]);
    } finally {
      sqlite.close();
    }
  });

  it("reseals changed membership only after acceptance, not a dependency hold or older-pointer refusal", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const eligibleIds = new Set(["usdt-tether", "usdc-circle", "dai-makerdao"]);
    const persist = (clock: number, ids: string[], score: number, degradedSources: string[] = []) =>
      persistDewsResults({
        db, results: ids.map((id) => buildDewsRow(id, score)), eligibleIds, degradedSources, nowSec: clock,
      });
    const daily = () => sqlite.prepare(
      "SELECT stablecoin_id, score FROM stress_signal_history ORDER BY stablecoin_id",
    ).all();
    try {
      await persist(nowSec - 120, ["usdt-tether", "usdc-circle"], 12);
      const before = daily();
      await expect(persist(nowSec - 60, ["usdt-tether", "dai-makerdao"], 80, ["yield-rankings-freshness"]))
        .resolves.toMatchObject({ publicationPointerWritten: false });
      expect(daily()).toEqual(before);
      await expect(persist(nowSec - 180, ["usdt-tether", "dai-makerdao"], 60))
        .resolves.toMatchObject({ publicationPointerWritten: false });
      expect(daily()).toEqual(before);
      await persist(nowSec, ["usdt-tether", "dai-makerdao"], 35);
      expect(daily()).toEqual([
        { stablecoin_id: "dai-makerdao", score: 35 }, { stablecoin_id: "usdt-tether", score: 35 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["buffer count", "stress_signal_publication_rows", "DELETE", "DEWS publication incomplete"],
    ["latest count", "stress_signals_latest", "DELETE", "DEWS publication incomplete"],
    ["buffer identity", "stress_signal_publication_rows", "UPDATE", "DEWS publication identity mismatch"],
    ["latest identity", "stress_signals_latest", "UPDATE", "DEWS publication identity mismatch"],
  ])("does not seed daily history when %s validation fails", async (_label, table, mutation, error) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const persist = (clock: number, score: number) => persistDewsResults({
      db, results: [buildDewsRow("usdt-tether", score)],
      eligibleIds: new Set(["usdt-tether", "usdc-circle"]), degradedSources: [], nowSec: clock,
    });
    try {
      sqlite.exec(`CREATE TRIGGER reject_candidate AFTER INSERT ON ${table} BEGIN
        ${mutation === "DELETE"
          ? `DELETE FROM ${table} WHERE stablecoin_id = NEW.stablecoin_id AND computed_at = NEW.computed_at`
          : `UPDATE ${table} SET stablecoin_id = 'usdc-circle' WHERE stablecoin_id = NEW.stablecoin_id AND computed_at = NEW.computed_at`};
        END;`);
      await expect(persist(nowSec - 60, 80)).rejects.toThrow(error);
      expect(sqlite.prepare("SELECT * FROM stress_signal_history").all()).toEqual([]);
      expect(await readDewsPublishedGenerationResult(db, nowSec)).toEqual({ status: "no-pointer" });
      sqlite.exec("DROP TRIGGER reject_candidate");
      await persist(nowSec, 42);
      expect(sqlite.prepare("SELECT stablecoin_id, score FROM stress_signal_history").all())
        .toEqual([{ stablecoin_id: "usdt-tether", score: 42 }]);
    } finally {
      sqlite.close();
    }
  });

  it("leaves daily history untouched when pointer acceptance fails", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.exec(`CREATE TRIGGER reject_pointer BEFORE INSERT ON cache
        WHEN NEW.key = 'dews:published-generation' BEGIN SELECT RAISE(ABORT, 'pointer acceptance failed'); END;`);
      await expect(persistDewsResults({
        db, results: [buildDewsRow("usdt-tether")], eligibleIds: new Set(["usdt-tether"]),
        degradedSources: [], nowSec: Math.floor(Date.now() / 1000),
      })).rejects.toThrow("pointer acceptance failed");
      expect(sqlite.prepare("SELECT * FROM stress_signal_history").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM surface_publication_generations WHERE surface = 'dews'").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("surfaces a post-acceptance daily seal failure without invalidating the accepted publication", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      sqlite.exec(`CREATE TRIGGER reject_daily BEFORE INSERT ON stress_signal_history
        BEGIN SELECT RAISE(ABORT, 'daily history seal failed'); END;`);
      await expect(persistDewsResults({
        db, results: [buildDewsRow("usdt-tether", 42)], eligibleIds: new Set(["usdt-tether"]),
        degradedSources: [], nowSec,
      })).rejects.toThrow("daily history seal failed");
      const observed = await observeDewsPublication(sqlite, db, nowSec);
      expect(observed.pointer).toMatchObject({ status: "ok", computedAt: nowSec });
      expect(observed.servedScores).toEqual({ "usdt-tether": 42 });
      expect(observed.ledger).toMatchObject([{ generationId: `dews:${nowSec}`, state: "published" }]);
      expect(observed.freshnessAt).toBe(nowSec);
      expect(sqlite.prepare("SELECT * FROM stress_signal_history").all()).toEqual([]);
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
        degradedSources: [],
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
