import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../../lib/yield-history-ownership-handoffs";
import {
  loadYieldHistorySnapshots,
  MAX_PREVIOUS_TVL_HISTORY_ROWS,
  purgeYieldHistoryOwnershipHandoffs,
} from "../yield-sync/history";
import { drainRowsBeforeCutoff, pruneYieldTables } from "../yield-sync/publication";

function createDb(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

function insertHistory(
  sqlite: DatabaseSync,
  row: {
    stablecoinId: string;
    sourceKey: string;
    recordedAt: number;
    isBest?: number;
    apy?: number;
    sourceTvlUsd?: number | null;
    publicationState?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO yield_history (
      stablecoin_id, source_key, recorded_at, is_best, apy, apy_base,
      source_tvl_usd, data_source, yield_source, yield_type, exchange_rate,
      publication_state
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'defillama', 'Test', 'lending', NULL, ?)`,
    )
    .run(
      row.stablecoinId,
      row.sourceKey,
      row.recordedAt,
      row.isBest ?? 0,
      row.apy ?? 1,
      row.sourceTvlUsd ?? null,
      row.publicationState === undefined ? "published" : row.publicationState,
    );
}

describe("loadYieldHistorySnapshots", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("keeps published and legacy anchors when newer staged rows compete", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    for (const [stablecoinId, publicationState] of [["coin-a", "published"], ["coin-b", null]] as const) {
      insertHistory(sqlite, { stablecoinId, sourceKey: "source-a", recordedAt: 100, isBest: 1, apy: 4, sourceTvlUsd: 10, publicationState });
      insertHistory(sqlite, { stablecoinId, sourceKey: "source-a", recordedAt: 200, isBest: 1, apy: 99, sourceTvlUsd: 999, publicationState: "staged" });
    }
    insertHistory(sqlite, { stablecoinId: "staged-only", sourceKey: "source-a", recordedAt: 200, isBest: 1, publicationState: "staged" });
    expect(sqlite.prepare("SELECT publication_state FROM yield_history WHERE stablecoin_id = 'coin-b' AND recorded_at = 100").get()).toEqual({ publication_state: null });

    for (const sourceKeysByStablecoin of [undefined, new Map(["coin-a", "coin-b", "staged-only"].map((id) => [id, new Set(["source-a"])]))]) {
      const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a", "coin-b", "staged-only"], 1_000, 300, { sourceKeysByStablecoin });
      const identities = (rows: typeof snapshots.historyRows) => rows.map((row) => [row.stablecoin_id, row.source_key, row.recorded_at, row.source_tvl_usd]);
      const expected = [["coin-a", "source-a", 100, 10], ["coin-b", "source-a", 100, 10]];
      expect(identities(snapshots.historyRows)).toEqual(expected);
      expect(identities(snapshots.prevTvlRows)).toEqual(expected);
      expect(identities(snapshots.prevBestRows)).toEqual(expected);
      expect(snapshots.historyRows.map((row) => row.apy)).toEqual([4, 4]);
      expect(snapshots.prevBestRows.map((row) => row.apy)).toEqual([4, 4]);
    }
  });

  it("returns one previous TVL row per stablecoin/source bucket", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 100, sourceTvlUsd: 10 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 200, sourceTvlUsd: 20 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-b", recordedAt: 150, sourceTvlUsd: 30 });
    insertHistory(sqlite, { stablecoinId: "coin-b", sourceKey: "source-c", recordedAt: 170, sourceTvlUsd: 40 });
    insertHistory(sqlite, { stablecoinId: "coin-b", sourceKey: "source-c", recordedAt: 190, sourceTvlUsd: 50 });

    const sourceKeysByStablecoin = new Map<string, Set<string>>([
      ["coin-a", new Set(["source-a", "source-b"])],
      ["coin-b", new Set(["source-c"])],
    ]);
    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a", "coin-b"], 1_000, 300, {
      sourceKeysByStablecoin,
    });

    expect(
      snapshots.prevTvlRows.map((row) => ({
        stablecoinId: row.stablecoin_id,
        sourceKey: row.source_key,
        recordedAt: row.recorded_at,
        tvl: row.source_tvl_usd,
      })),
    ).toEqual([
      { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 200, tvl: 20 },
      { stablecoinId: "coin-a", sourceKey: "source-b", recordedAt: 150, tvl: 30 },
      { stablecoinId: "coin-b", sourceKey: "source-c", recordedAt: 190, tvl: 50 },
    ]);
  });

  it("returns one previous-best row per stablecoin", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, {
      stablecoinId: "coin-a",
      sourceKey: "source-old",
      recordedAt: 100,
      isBest: 1,
      sourceTvlUsd: 10,
    });
    insertHistory(sqlite, {
      stablecoinId: "coin-a",
      sourceKey: "source-new",
      recordedAt: 200,
      isBest: 1,
      sourceTvlUsd: 20,
    });
    insertHistory(sqlite, {
      stablecoinId: "coin-b",
      sourceKey: "source-b",
      recordedAt: 150,
      isBest: 1,
      sourceTvlUsd: 30,
    });

    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a", "coin-b"], 1_000, 300);

    expect(
      snapshots.prevBestRows.map((row) => ({
        stablecoinId: row.stablecoin_id,
        sourceKey: row.source_key,
        recordedAt: row.recorded_at,
      })),
    ).toEqual([
      { stablecoinId: "coin-a", sourceKey: "source-new", recordedAt: 200 },
      { stablecoinId: "coin-b", sourceKey: "source-b", recordedAt: 150 },
    ]);
  });

  it("excludes ownership-handoff rows before selecting previous-best anchors", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, {
      stablecoinId: "usde-ethena",
      sourceKey: "valid-source",
      recordedAt: 100,
      isBest: 1,
      sourceTvlUsd: 10,
    });
    insertHistory(sqlite, {
      stablecoinId: "usde-ethena",
      sourceKey: LEGACY_BEST_YIELD_SOURCE_KEY,
      recordedAt: 200,
      isBest: 1,
      sourceTvlUsd: 20,
    });

    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["usde-ethena"], 1_000, 300);

    expect(snapshots.prevBestRows).toHaveLength(1);
    expect(snapshots.prevBestRows[0]?.source_key).toBe("valid-source");
    expect(snapshots.prevBestRows[0]?.recorded_at).toBe(100);
  });

  it("bounds previous-history materialization without pre-counting old candidates", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, {
      stablecoinId: "coin-a",
      sourceKey: "source-a",
      recordedAt: 100,
      isBest: 1,
      sourceTvlUsd: 10,
    });
    insertHistory(sqlite, {
      stablecoinId: "coin-a",
      sourceKey: "source-a",
      recordedAt: 200,
      isBest: 1,
      sourceTvlUsd: 20,
    });
    insertHistory(sqlite, {
      stablecoinId: "coin-a",
      sourceKey: "source-b",
      recordedAt: 150,
      isBest: 0,
      sourceTvlUsd: 30,
    });

    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a"], 1_000, 300, {
      sourceKeysByStablecoin: new Map([["coin-a", new Set(["source-a"])]]),
    });

    expect(
      snapshots.prevTvlRows.map((row) => ({
        sourceKey: row.source_key,
        recordedAt: row.recorded_at,
      })),
    ).toEqual([
      { sourceKey: "source-a", recordedAt: 200 },
    ]);
    expect(
      snapshots.prevBestRows.map((row) => ({
        sourceKey: row.source_key,
        recordedAt: row.recorded_at,
      })),
    ).toEqual([{ sourceKey: "source-a", recordedAt: 200 }]);
  });
  it("caps previous TVL history rows and reports truncation", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 100, sourceTvlUsd: 10 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-b", recordedAt: 110, sourceTvlUsd: 20 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-c", recordedAt: 120, sourceTvlUsd: 30 });

    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a"], 1_000, 300, {
      maxPreviousTvlRows: 2,
    });

    expect(snapshots.prevTvlRows.map((row) => row.source_key)).toEqual(["source-a", "source-b"]);
    expect(snapshots.previousTvlRowsTruncated).toBe(true);
  });

  it("caps source-key-scoped previous TVL history rows and reports truncation", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 100, sourceTvlUsd: 10 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-b", recordedAt: 110, sourceTvlUsd: 20 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-c", recordedAt: 120, sourceTvlUsd: 30 });

    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a"], 1_000, 300, {
      maxPreviousTvlRows: 2,
      sourceKeysByStablecoin: new Map([["coin-a", new Set(["source-a", "source-b", "source-c"])]]),
    });

    expect(snapshots.prevTvlRows.map((row) => row.source_key)).toEqual(["source-a", "source-b"]);
    expect(snapshots.previousTvlRowsTruncated).toBe(true);
  });

  it("uses a default previous TVL cap large enough for normal history", () => {
    expect(MAX_PREVIOUS_TVL_HISTORY_ROWS).toBeGreaterThan(1_000);
  });
});

describe("purgeYieldHistoryOwnershipHandoffs", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("deletes handed-off keys from both the raw and the daily history tier", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const [onchainKey, handedOffKey] = YIELD_HISTORY_OWNERSHIP_HANDOFFS["usde-ethena"];
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: LEGACY_BEST_YIELD_SOURCE_KEY, recordedAt: 300 });
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: handedOffKey, recordedAt: 200 });
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: onchainKey, recordedAt: 100 });
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: "valid-source", recordedAt: 150 });
    insertHistory(sqlite, { stablecoinId: "susde-ethena", sourceKey: LEGACY_BEST_YIELD_SOURCE_KEY, recordedAt: 100 });

    const insertDaily = sqlite.prepare(
      `INSERT INTO yield_history_daily
         (stablecoin_id, source_key, snapshot_date, recorded_at, is_best, apy, data_source, publication_state)
       VALUES (?, ?, 86400, ?, 1, ?, 'defillama', 'published')`,
    );
    insertDaily.run("usde-ethena", LEGACY_BEST_YIELD_SOURCE_KEY, 300, 4.0);
    insertDaily.run("usde-ethena", handedOffKey, 200, 5.0);
    insertDaily.run("usde-ethena", "valid-source", 150, 3.0);
    insertDaily.run("susde-ethena", LEGACY_BEST_YIELD_SOURCE_KEY, 100, 6.0);

    await purgeYieldHistoryOwnershipHandoffs(fixture.db);

    // Raw tier: every suppressed key family for the handed-off coin is gone;
    // other coins and the coin's non-handoff source are untouched.
    expect(
      sqlite.prepare("SELECT stablecoin_id, source_key FROM yield_history ORDER BY stablecoin_id, source_key").all(),
    ).toEqual([
      { stablecoin_id: "susde-ethena", source_key: LEGACY_BEST_YIELD_SOURCE_KEY },
      { stablecoin_id: "usde-ethena", source_key: "valid-source" },
    ]);

    // Daily tier: the same key set is purged there too, while non-handoff
    // sources of the same coin survive. Without this pass, de-registering a
    // handoff would instantly re-expose a year of materialized daily rows.
    expect(
      sqlite
        .prepare("SELECT stablecoin_id, source_key FROM yield_history_daily ORDER BY stablecoin_id, source_key")
        .all(),
    ).toEqual([
      { stablecoin_id: "susde-ethena", source_key: LEGACY_BEST_YIELD_SOURCE_KEY },
      { stablecoin_id: "usde-ethena", source_key: "valid-source" },
    ]);
  });
});

describe("pruneYieldTables retention", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("prunes raw history at the 30-day raw policy while keeping the year of daily closes", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const nowSec = 1_800_000_000;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: nowSec - 10 * DAY_SECONDS });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: nowSec - 40 * DAY_SECONDS });
    sqlite
      .prepare(
        `INSERT INTO yield_history_daily
           (stablecoin_id, source_key, snapshot_date, recorded_at, is_best, apy, data_source, publication_state)
         VALUES ('coin-a', 'source-a', ?, ?, 1, 4.0, 'defillama', 'published')`,
      )
      .run(nowSec - 100 * DAY_SECONDS, nowSec - 100 * DAY_SECONDS);

    await pruneYieldTables(fixture.db, nowSec, { allowDestructiveCleanup: false });

    expect(sqlite.prepare("SELECT recorded_at FROM yield_history").all()).toEqual([
      { recorded_at: nowSec - 10 * DAY_SECONDS },
    ]);
    expect(sqlite.prepare("SELECT snapshot_date FROM yield_history_daily").all()).toEqual([
      { snapshot_date: nowSec - 100 * DAY_SECONDS },
    ]);
  });

  it("resumes a large retention backlog across bounded statements instead of one fatal delete", async () => {
    // Regression: v8.43 moved the raw-history cutoff from 365d to 30d, putting
    // the entire 30d-365d backlog in scope at once. One unbounded DELETE over
    // millions of rows exceeded the D1 per-query CPU limit, failing the whole
    // publication run with `D1_ERROR: D1 DB exceeded its CPU time limit` — and
    // it failed the same way every hour. The drain must be bounded and resumable.
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const nowSec = 1_800_000_000;
    const cutoffSec = nowSec - 30 * DAY_SECONDS;
    for (let index = 0; index < 12_000; index += 1) {
      insertHistory(sqlite, {
        stablecoinId: `coin-${index % 20}`,
        sourceKey: "source-a",
        recordedAt: nowSec - 40 * DAY_SECONDS - index,
      });
    }
    const countRows = (): number => {
      const row = sqlite?.prepare("SELECT COUNT(*) AS n FROM yield_history").get();
      if (!row || typeof row !== "object" || !("n" in row) || typeof row.n !== "number") {
        throw new Error("unexpected sqlite count shape");
      }
      return row.n;
    };
    expect(countRows()).toBe(12_000);

    const drain = () =>
      drainRowsBeforeCutoff({
        db: fixture.db,
        table: "yield_history",
        statementTag: "history-retention-delete",
        timeColumn: "recorded_at",
        cutoffSec,
        frozenIdsList: [],
        frozenClause: "",
        maxRows: 5_000,
      });

    // Three bounded passes, each capped, and the third finds only the remainder.
    const first = await drain();
    expect(first.deleted).toBe(5_000);
    expect(first.budgetExhausted).toBe(true);
    expect(countRows()).toBe(7_000);

    const second = await drain();
    expect(second.deleted).toBe(5_000);
    expect(countRows()).toBe(2_000);

    const third = await drain();
    expect(third.deleted).toBe(2_000);
    expect(third.budgetExhausted).toBe(false);
    expect(countRows()).toBe(0);
  });
});
