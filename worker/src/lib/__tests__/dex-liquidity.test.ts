import { describe, expect, it, vi } from "vitest";
import { loadDexLiquiditySnapshot } from "../dex-liquidity";

function mockDb(rows: unknown[]): D1Database {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn().mockResolvedValue({ results: rows }),
    })),
  } as unknown as D1Database;
}

describe("loadDexLiquiditySnapshot", () => {
  it("preserves republished evidence and deployment coverage", async () => {
    const db = mockDb([
      {
        stablecoin_id: "coin-a",
        liquidity_score: 91,
        concentration_hhi: 0.2,
        pool_count: 4,
        chain_count: 2,
        total_tvl_usd: 20_000_000,
        effective_tvl_usd: 15_000_000,
        coverage_class: "primary",
        coverage_confidence: 0.9,
        balance_measured_tvl_usd: 12_000_000,
        organic_measured_tvl_usd: 9_000_000,
        deployment_total: 3,
        deployment_observed_pools: 1,
        deployment_verified_no_pools: 1,
        deployment_provider_inaccessible: 1,
        updated_at: 123,
      },
    ]);

    await expect(loadDexLiquiditySnapshot(db)).resolves.toEqual({
      map: {
        "coin-a": {
          liquidityScore: 91,
          concentrationHhi: 0.2,
          poolCount: 4,
          chainCount: 2,
          coverageClass: "primary",
          coverageConfidence: 0.9,
          liquidityEvidenceClass: "measured",
          hasMeasuredLiquidityEvidence: true,
          effectiveTvlUsd: 15_000_000,
          balanceMeasuredTvlUsd: 12_000_000,
          organicMeasuredTvlUsd: 9_000_000,
          deploymentCoverage: { observedPools: 1, verifiedNoPools: 1, providerInaccessible: 1 },
        },
      },
      latestUpdatedAt: 123,
    });
  });

  it("keeps old rows evidence-neutral", async () => {
    const db = mockDb([
      {
        stablecoin_id: "legacy",
        liquidity_score: 80,
        concentration_hhi: null,
        pool_count: 1,
        chain_count: 1,
        total_tvl_usd: 1_000_000,
        effective_tvl_usd: null,
        coverage_class: null,
        coverage_confidence: null,
        balance_measured_tvl_usd: null,
        organic_measured_tvl_usd: null,
        deployment_total: 0,
        deployment_observed_pools: 0,
        deployment_verified_no_pools: 0,
        deployment_provider_inaccessible: 0,
        updated_at: 100,
      },
    ]);

    const result = await loadDexLiquiditySnapshot(db);
    expect(result.map.legacy).toEqual({
      liquidityScore: 80,
      concentrationHhi: null,
      poolCount: 1,
      chainCount: 1,
    });
  });
});
