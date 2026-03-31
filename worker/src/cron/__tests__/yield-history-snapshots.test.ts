import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
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
    const result = await loadYieldHistorySnapshots(db, resolvedIds, 1_800_000_000, 1_799_000_000);

    expect(result.historyRows).toHaveLength(130_000);
    expect(result.prevTvlRows).toHaveLength(0);
    expect(result.prevBestRows).toHaveLength(0);
  });
});
