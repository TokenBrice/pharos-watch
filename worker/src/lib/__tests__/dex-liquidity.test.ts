import { describe, expect, it, vi } from "vitest";
import { loadDexLiquiditySnapshot } from "../dex-liquidity";

function mockDb(rows: unknown[]): D1Database {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn().mockResolvedValue({ results: rows }),
    })),
  } as unknown as D1Database;
}

function liquidityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stablecoin_id: "usdc-circle",
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
    methodology_version: "5.10",
    deployment_chain: null,
    deployment_contract_address: null,
    deployment_outcome: null,
    updated_at: 123,
    ...overrides,
  };
}

describe("loadDexLiquiditySnapshot", () => {
  it("preserves republished evidence and deployment coverage", async () => {
    const db = mockDb([
      liquidityRow({
        deployment_chain: "ethereum",
        deployment_contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        deployment_outcome: "observed_pools",
      }),
      liquidityRow({
        deployment_chain: "arbitrum",
        deployment_contract_address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        deployment_outcome: "verified_no_pools",
      }),
      liquidityRow({
        deployment_chain: "base",
        deployment_contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        deployment_outcome: "provider_inaccessible",
      }),
    ]);

    await expect(loadDexLiquiditySnapshot(db)).resolves.toEqual({
      map: {
        "usdc-circle": {
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
          methodologyVersion: "5.10",
          deploymentCoverage: { observedPools: 1, verifiedNoPools: 1, providerInaccessible: 1 },
        },
      },
      latestUpdatedAt: 123,
    });
  });

  it("keeps old rows evidence-neutral", async () => {
    const db = mockDb([
      liquidityRow({
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
        updated_at: 100,
      }),
    ]);

    const result = await loadDexLiquiditySnapshot(db);
    expect(result.map.legacy).toEqual({
      liquidityScore: 80,
      concentrationHhi: null,
      poolCount: 1,
      chainCount: 1,
      methodologyVersion: "5.10",
    });
  });

  it("rejects redemption-family observations persisted in the DEX lane", async () => {
    const redemptionObservation = {
      routeId: "redeem:misrouted",
      routeFamily: "issuer-redemption",
      scope: { kind: "issuer", issuerId: "issuer" },
      requestedNotionalUsd: 100_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 100_000,
      completionRatio: 1,
      output: { kind: "fiat", currency: "USD" },
      evidenceKind: "documented-terms",
      confidence: "high",
      scoreEligible: true,
      observedAt: 100,
      freshnessSeconds: 0,
      commonModeKeys: ["issuer:test"],
    };
    const scoreComponents = {
      exitRouteObservations: [redemptionObservation],
      exitRouteObservationCoverage: {
        status: "populated",
        capabilityMatrixVersion: "test-v1",
        retainedPoolCount: 1,
        observationCount: 1,
        scoreEligibleObservationCount: 1,
        scoreEligiblePoolCount: 1,
        unsupportedPoolCount: 0,
        evidenceCounts: { "documented-terms": 1 },
        unsupportedReasons: {},
      },
    };

    await expect(
      loadDexLiquiditySnapshot(mockDb([liquidityRow({ score_components_json: JSON.stringify(scoreComponents) })])),
    ).rejects.toThrow("Invalid persisted DEX exit-route observations for usdc-circle");
  });

  it("quarantines malformed coverage evidence without suppressing valid rows", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const baseRow = liquidityRow({
      stablecoin_id: "valid",
      liquidity_score: 90,
      concentration_hhi: null,
      pool_count: 1,
      chain_count: 1,
      total_tvl_usd: 1_000_000,
      effective_tvl_usd: 1_000_000,
      coverage_class: "primary",
      coverage_confidence: 0.9,
      balance_measured_tvl_usd: 1_000_000,
      organic_measured_tvl_usd: 1_000_000,
      updated_at: 100,
    });

    const result = await loadDexLiquiditySnapshot(
      mockDb([
        baseRow,
        { ...baseRow, stablecoin_id: "bad-class", coverage_class: "unexpected" },
        { ...baseRow, stablecoin_id: "bad-confidence", coverage_confidence: 1.1 },
        { ...baseRow, stablecoin_id: "incomplete", coverage_confidence: null },
      ]),
    );

    expect(Object.keys(result.map)).toEqual(["valid"]);
    expect(consoleError).toHaveBeenCalledTimes(3);
    expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("bad-class"),
      expect.stringContaining("bad-confidence"),
      expect.stringContaining("incomplete"),
    ]);
    consoleError.mockRestore();
  });

  it("ignores outcomes for deployments removed from the active catalog", async () => {
    const result = await loadDexLiquiditySnapshot(
      mockDb([
        liquidityRow({
          deployment_chain: "ethereum",
          deployment_contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          deployment_outcome: "verified_no_pools",
        }),
        liquidityRow({
          deployment_chain: "ethereum",
          deployment_contract_address: "0x000000000000000000000000000000000000dead",
          deployment_outcome: "provider_inaccessible",
        }),
      ]),
    );

    expect(result.map["usdc-circle"].deploymentCoverage).toEqual({
      observedPools: 0,
      verifiedNoPools: 1,
      providerInaccessible: 0,
    });
  });

  it("matches deployment coverage with chain-aware address canonicalization", async () => {
    const solanaMint = "HQMYCZTDq9g3oZejDRUeQsFtLKgyfvBpD3yHaTnain3L";
    const result = await loadDexLiquiditySnapshot(
      mockDb([
        liquidityRow({
          stablecoin_id: "eusd-telcoin",
          deployment_chain: "solana",
          deployment_contract_address: solanaMint,
          deployment_outcome: "observed_pools",
        }),
        liquidityRow({
          stablecoin_id: "eusd-telcoin",
          deployment_chain: "solana",
          deployment_contract_address: solanaMint.toLowerCase(),
          deployment_outcome: "verified_no_pools",
        }),
      ]),
    );

    expect(result.map["eusd-telcoin"].deploymentCoverage).toEqual({
      observedPools: 1,
      verifiedNoPools: 0,
      providerInaccessible: 0,
    });
  });
});
