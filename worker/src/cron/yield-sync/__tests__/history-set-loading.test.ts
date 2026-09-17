import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { loadYieldHistorySnapshots } from "../history";

describe("yield history set loading", () => {
  it("loads previous TVL only for requested pairs while retaining selected history", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(
        `INSERT INTO yield_history (
           stablecoin_id, source_key, recorded_at, is_best, apy,
           source_tvl_usd, data_source, publication_state
         ) VALUES ('coin-a', ?, ?, ?, 4.2, ?, 'test', 'published')`,
      );
      insert.run("source-a", 100, 0, 10);
      insert.run("source-a", 200, 0, 20);
      insert.run("source-b", 150, 1, 30);
      insert.run("source-c", 175, 0, 40);

      const snapshots = await loadYieldHistorySnapshots(
        db,
        ["coin-a"],
        1_000,
        300,
        {
          sourceKeysByStablecoin: new Map([
            ["coin-a", new Set(["source-a"])],
          ]),
        },
      );

      expect(
        snapshots.historyRows.map((row) => [row.source_key, row.recorded_at]),
      ).toEqual([
        ["source-a", 100],
        ["source-b", 150],
        ["source-a", 200],
      ]);
      expect(
        snapshots.prevTvlRows.map((row) => [row.source_key, row.recorded_at]),
      ).toEqual([["source-a", 200]]);
      expect(snapshots.previousTvlRowsTruncated).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
