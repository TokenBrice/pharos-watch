import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { LEGACY_BEST_YIELD_SOURCE_KEY } from "../../lib/yield-history-ownership-handoffs";
import { loadYieldHistorySnapshots, MAX_PREVIOUS_TVL_HISTORY_ROWS } from "../yield-sync/history";

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
      row.publicationState ?? "published",
    );
}

describe("loadYieldHistorySnapshots", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
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
