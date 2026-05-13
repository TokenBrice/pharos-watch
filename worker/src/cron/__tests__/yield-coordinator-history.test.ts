import { describe, expect, it } from "vitest";
import { buildYieldHistoryEvaluationInputs } from "../yield-sync/coordinator-history";
import type { YieldHistorySnapshotRow } from "../yield-sync/history";

function row(overrides: Partial<YieldHistorySnapshotRow>): YieldHistorySnapshotRow {
  return {
    stablecoin_id: "coin-a",
    source_key: "source-a",
    recorded_at: 1_700_000_000,
    is_best: 0,
    apy: 4.2,
    apy_base: null,
    source_tvl_usd: 1_000_000,
    data_source: "defillama",
    yield_source: "Source A",
    yield_type: "lending",
    exchange_rate: null,
    ...overrides,
  };
}

describe("yield coordinator history", () => {
  it("normalizes source, legacy, on-chain, TVL, and previous-best history inputs", () => {
    const result = buildYieldHistoryEvaluationInputs({
      historyRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a" }),
        row({
          stablecoin_id: "coin-a",
          source_key: null,
          data_source: "onchain",
          exchange_rate: 1.01,
        }),
        row({
          stablecoin_id: "lusd-liquity",
          source_key: "bprotocol-lqty-only",
          data_source: "onchain",
          exchange_rate: 1.02,
        }),
      ],
      prevTvlRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a", source_tvl_usd: 9_000 }),
        row({ stablecoin_id: "coin-a", source_key: null, source_tvl_usd: 7_000 }),
        row({ stablecoin_id: "coin-a", source_key: "source-a", source_tvl_usd: 8_000 }),
      ],
      prevBestRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a", is_best: 1 }),
      ],
    });

    expect(result.sourceHistory.get("coin-a::source-a")).toHaveLength(1);
    expect(result.legacyHistoryById.get("coin-a")?.[0]?.source_key).toBe("legacy-best");
    expect(result.onChainCompatibilityHistoryById.get("coin-a")).toHaveLength(1);
    expect(result.legacyDeterministicOnChainHistoryById.get("lusd-liquity")).toHaveLength(1);
    expect(result.prevTvlBySource.get("coin-a::source-a")).toBe(9_000);
    expect(result.legacyPrevTvlById.get("coin-a")).toBe(7_000);
    expect(result.prevBestSourceKeyByCoin.get("coin-a")).toBe("source-a");
  });

  it("counts selected-source switches across 30d history rows", () => {
    const result = buildYieldHistoryEvaluationInputs({
      historyRows: [
        row({ stablecoin_id: "coin-a", source_key: "source-a", is_best: 1, recorded_at: 100 }),
        row({ stablecoin_id: "coin-a", source_key: "source-a", is_best: 1, recorded_at: 200 }),
        row({ stablecoin_id: "coin-a", source_key: "source-b", is_best: 1, recorded_at: 300 }),
        row({ stablecoin_id: "coin-a", source_key: "source-c", is_best: 0, recorded_at: 400 }),
        row({ stablecoin_id: "coin-a", source_key: "source-a", is_best: 1, recorded_at: 500 }),
      ],
      prevTvlRows: [],
      prevBestRows: [],
    });

    expect(result.sourceSwitchCount30dByCoin.get("coin-a")).toBe(2);
  });
});
