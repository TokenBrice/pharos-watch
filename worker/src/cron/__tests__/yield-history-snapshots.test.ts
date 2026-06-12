import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadYieldHistorySnapshots } from "../yield-sync/history";

function makeHistoryRow(index: number) {
  return {
    stablecoin_id: `coin-${index % 90}`,
    source_key: `source-${index % 7}`,
    recorded_at: 1_700_000_000 + index,
    is_best: index % 2,
    apy: 5 + (index % 10),
    source_tvl_usd: 1_000_000 + index,
    data_source: "defillama",
    yield_source: "Test Source",
    yield_type: "lending-vault",
    exchange_rate: null,
  };
}

describe("loadYieldHistorySnapshots", () => {
  it("does not overflow when a single chunk returns more rows than the JS spread limit", async () => {
    const largeHistoryResult = Array.from({ length: 130_000 }, (_, index) => makeHistoryRow(index));
    const db = mockD1([
      { match: "recorded_at >= ?", rows: largeHistoryResult },
      { match: "source_tvl_usd IS NOT NULL", rows: [] },
      { match: "is_best = 1", rows: [] },
    ]);

    const resolvedIds = Array.from({ length: 90 }, (_, index) => `coin-${index}`);
    const result = await loadYieldHistorySnapshots(db, resolvedIds, 1_800_000_000, 1_799_000_000, {
      chunkSize: 90,
    });

    expect(result.historyRows).toHaveLength(130_000);
    expect(result.prevTvlRows).toHaveLength(0);
    expect(result.prevBestRows).toHaveLength(0);
  });

  it("reports bounded progress across history chunks", async () => {
    const db = mockD1([
      { match: "recorded_at >= ?", rows: [] },
      { match: "source_tvl_usd IS NOT NULL", rows: [] },
      { match: "is_best = 1", rows: [] },
    ]);
    const progress: Array<{ chunksDone: number; chunksTotal: number; resolvedIdsDone: number }> = [];

    const resolvedIds = Array.from({ length: 31 }, (_, index) => `coin-${index}`);
    await loadYieldHistorySnapshots(db, resolvedIds, 1_800_000_000, 1_799_000_000, {
      chunkSize: 30,
      onProgress: (snapshot) => {
        progress.push({
          chunksDone: snapshot.chunksDone,
          chunksTotal: snapshot.chunksTotal,
          resolvedIdsDone: snapshot.resolvedIdsDone,
        });
      },
    });

    expect(progress[0]).toEqual({ chunksDone: 0, chunksTotal: 2, resolvedIdsDone: 0 });
    expect(progress[progress.length - 1]).toEqual({ chunksDone: 2, chunksTotal: 2, resolvedIdsDone: 31 });
  });
});
