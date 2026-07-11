import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { writeHistoricalSnapshots } from "../dex-liquidity/persistence";
import type { FullScoreResult } from "../dex-liquidity/types";

const NOW_SEC = Math.floor(Date.UTC(2026, 6, 10, 12) / 1000);
const SNAPSHOT_DATE = NOW_SEC - (NOW_SEC % 86_400);
const ACTIVE_ID_LIST = ACTIVE_STABLECOINS.map((coin) => coin.id);

interface StoredIdentityRow {
  stablecoin_id: string;
  liquidity_score: number | null;
}

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE dex_liquidity_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stablecoin_id TEXT NOT NULL,
      total_tvl_usd REAL NOT NULL,
      total_volume_24h_usd REAL NOT NULL DEFAULT 0,
      liquidity_score INTEGER,
      snapshot_date INTEGER NOT NULL,
      methodology_version TEXT NOT NULL,
      coverage_class TEXT NOT NULL DEFAULT 'unobserved',
      coverage_confidence REAL NOT NULL DEFAULT 0,
      source_mix_json TEXT
    );
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function makeScore(score = 80): FullScoreResult {
  return {
    tvl: 1_000_000,
    effectiveTvl: 900_000,
    vol24h: 100_000,
    score,
    hhi: 0.1,
    durability: 80,
    components: {
      tvlDepth: 80,
      volumeActivity: 80,
      poolQuality: 80,
      durability: 80,
      pairDiversity: 80,
    },
    weightedBalanceRatio: 1,
    organicFrac: 1,
    avgStress: 0,
    lockedLiqPct: null,
    coverageClass: "primary",
    coverageConfidence: 1,
    sourceMix: { dl: { poolCount: 1, tvlUsd: 1_000_000 } },
    balanceMeasuredTvlUsd: 1_000_000,
    organicMeasuredTvlUsd: 1_000_000,
  };
}

function insertSnapshotRows(
  sqlite: DatabaseSync,
  ids: readonly string[],
  scoredIds: ReadonlySet<string>,
): void {
  const insert = sqlite.prepare(
    `INSERT INTO dex_liquidity_history (
       stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
       methodology_version, coverage_class, coverage_confidence, source_mix_json
     ) VALUES (?, ?, ?, ?, ?, 'test', ?, ?, NULL)`,
  );
  for (const id of ids) {
    const scored = scoredIds.has(id);
    insert.run(id, scored ? 100 : 0, scored ? 10 : 0, scored ? 50 : null, SNAPSHOT_DATE, scored ? "primary" : "unobserved", scored ? 1 : 0);
  }
}

function loadSnapshotIdentity(sqlite: DatabaseSync): StoredIdentityRow[] {
  return sqlite
    .prepare(
      `SELECT stablecoin_id, liquidity_score
       FROM dex_liquidity_history
       WHERE snapshot_date = ?
       ORDER BY id`,
    )
    .all(SNAPSHOT_DATE) as unknown as StoredIdentityRow[];
}

function expectExactActiveIdentity(rows: readonly StoredIdentityRow[]): void {
  expect(rows).toHaveLength(ACTIVE_ID_LIST.length);
  expect(new Set(rows.map((row) => row.stablecoin_id))).toEqual(new Set(ACTIVE_ID_LIST));
}

describe("DEX liquidity history atomic identity replacement", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
    vi.restoreAllMocks();
  });

  it("repairs a same-count active-ID swap in one bounded batch", async () => {
    const fixture = createHarness();
    sqlite = fixture.sqlite;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const scoredId = ACTIVE_ID_LIST[0]!;
    const missingActiveId = ACTIVE_ID_LIST[ACTIVE_ID_LIST.length - 1]!;
    const staleId = "removed-from-active-universe";
    insertSnapshotRows(sqlite, [...ACTIVE_ID_LIST.slice(0, -1), staleId], new Set([scoredId]));
    const batchSpy = vi.spyOn(fixture.db, "batch");

    const result = await writeHistoricalSnapshots(
      fixture.db,
      new Map([[scoredId, makeScore()]]),
      undefined,
      NOW_SEC,
    );

    expect(result).toMatchObject({
      snapshotRowsWritten: ACTIVE_ID_LIST.length,
      skipped: false,
      writeFailed: false,
    });
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]?.[0].length).toBeLessThanOrEqual(100);
    const rows = loadSnapshotIdentity(sqlite);
    expectExactActiveIdentity(rows);
    expect(rows.some((row) => row.stablecoin_id === staleId)).toBe(false);
    expect(rows.some((row) => row.stablecoin_id === missingActiveId)).toBe(true);
  });

  it("removes surplus and inactive scored IDs after an active-universe shrink", async () => {
    const fixture = createHarness();
    sqlite = fixture.sqlite;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const activeScoredId = ACTIVE_ID_LIST[0]!;
    const retainedScoredId = ACTIVE_ID_LIST[1]!;
    const staleId = "formerly-active-stablecoin";
    insertSnapshotRows(
      sqlite,
      [...ACTIVE_ID_LIST, staleId],
      new Set([activeScoredId, retainedScoredId, staleId]),
    );

    const result = await writeHistoricalSnapshots(
      fixture.db,
      new Map([
        [activeScoredId, makeScore()],
        [staleId, makeScore(70)],
      ]),
      undefined,
      NOW_SEC,
    );

    expect(result.writeFailed).toBe(false);
    const rows = loadSnapshotIdentity(sqlite);
    expectExactActiveIdentity(rows);
    expect(rows.filter((row) => row.liquidity_score != null).map((row) => row.stablecoin_id)).toEqual([
      activeScoredId,
      retainedScoredId,
    ]);
  });

  it("repairs same-count scored identity drift without discarding the richer existing row", async () => {
    const fixture = createHarness();
    sqlite = fixture.sqlite;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const oldScoredId = ACTIVE_ID_LIST[0]!;
    const incomingScoredId = ACTIVE_ID_LIST[1]!;
    insertSnapshotRows(sqlite, ACTIVE_ID_LIST, new Set([oldScoredId]));

    const result = await writeHistoricalSnapshots(
      fixture.db,
      new Map([[incomingScoredId, makeScore()]]),
      undefined,
      NOW_SEC,
    );

    expect(result).toMatchObject({ skipped: false, writeFailed: false });
    const scoredRows = loadSnapshotIdentity(sqlite).filter((row) => row.liquidity_score != null);
    expect(scoredRows.map((row) => row.stablecoin_id)).toEqual([oldScoredId, incomingScoredId]);
    expect(scoredRows.find((row) => row.stablecoin_id === oldScoredId)?.liquidity_score).toBe(50);
    expect(
      sqlite
        .prepare(
          `SELECT total_tvl_usd, total_volume_24h_usd, liquidity_score, methodology_version,
                  coverage_class, coverage_confidence, source_mix_json
           FROM dex_liquidity_history
           WHERE snapshot_date = ? AND stablecoin_id = ?`,
        )
        .get(SNAPSHOT_DATE, oldScoredId),
    ).toMatchObject({
      total_tvl_usd: 100,
      total_volume_24h_usd: 10,
      liquidity_score: 50,
      methodology_version: "test",
      coverage_class: "primary",
      coverage_confidence: 1,
      source_mix_json: null,
    });
  });

  it("keeps a richer exact snapshot when the incoming run is degraded", async () => {
    const fixture = createHarness();
    sqlite = fixture.sqlite;
    const incomingScoredId = ACTIVE_ID_LIST[0]!;
    const richerExistingId = ACTIVE_ID_LIST[1]!;
    insertSnapshotRows(sqlite, ACTIVE_ID_LIST, new Set([incomingScoredId, richerExistingId]));
    const before = loadSnapshotIdentity(sqlite);
    const batchSpy = vi.spyOn(fixture.db, "batch");

    const result = await writeHistoricalSnapshots(
      fixture.db,
      new Map([[incomingScoredId, makeScore()]]),
      undefined,
      NOW_SEC,
    );

    expect(result).toMatchObject({
      snapshotRowsWritten: 0,
      skipped: true,
      writeFailed: false,
    });
    expect(batchSpy).not.toHaveBeenCalled();
    expect(loadSnapshotIdentity(sqlite)).toEqual(before);
  });

  it("collapses duplicate identities left by a partial retry", async () => {
    const fixture = createHarness();
    sqlite = fixture.sqlite;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const scoredId = ACTIVE_ID_LIST[0]!;
    insertSnapshotRows(sqlite, ACTIVE_ID_LIST.slice(0, 10), new Set([scoredId]));
    insertSnapshotRows(sqlite, [scoredId, scoredId], new Set([scoredId]));

    const result = await writeHistoricalSnapshots(
      fixture.db,
      new Map([[scoredId, makeScore()]]),
      undefined,
      NOW_SEC,
    );

    expect(result.writeFailed).toBe(false);
    const rows = loadSnapshotIdentity(sqlite);
    expectExactActiveIdentity(rows);
    expect(rows.filter((row) => row.stablecoin_id === scoredId)).toHaveLength(1);
  });

  it("rolls back the date delete when any replacement insert fails", async () => {
    const fixture = createHarness();
    sqlite = fixture.sqlite;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scoredId = ACTIVE_ID_LIST[0]!;
    const staleId = "state-that-must-survive-the-fault";
    insertSnapshotRows(sqlite, [...ACTIVE_ID_LIST.slice(0, -1), staleId], new Set([scoredId]));
    const before = loadSnapshotIdentity(sqlite);
    sqlite.exec(`
      CREATE TRIGGER fail_dex_history_replacement
      BEFORE INSERT ON dex_liquidity_history
      WHEN NEW.stablecoin_id = '${scoredId.replaceAll("'", "''")}'
      BEGIN
        SELECT RAISE(ABORT, 'injected history replacement failure');
      END;
    `);

    const result = await writeHistoricalSnapshots(
      fixture.db,
      new Map([[scoredId, makeScore()]]),
      undefined,
      NOW_SEC,
    );

    expect(result).toEqual({
      snapshotRowsWritten: 0,
      skipped: false,
      writeFailed: true,
      historyRowsPruned: 0,
      retentionPruneFailed: false,
    });
    expect(loadSnapshotIdentity(sqlite)).toEqual(before);
    expect(warnSpy).toHaveBeenCalledWith("[dex-liquidity] Daily snapshot failed:", expect.any(Error));
  });
});
