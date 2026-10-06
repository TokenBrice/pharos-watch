import { describe, expect, it, vi } from "vitest";
import { loadDexLiquidityMap, loadDexLiquiditySnapshot, loadDexLiquidityScores } from "../dex-liquidity";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

function mockDb(rows: Record<string, unknown>[]): D1Database {
  const evidenceRows = [...new Map(rows.map((row) => [row.stablecoin_id, row])).values()];
  const deploymentRows = rows.filter((row) => row.deployment_outcome != null).map((row) => ({
    stablecoin_id: row.stablecoin_id,
    deployment_chain: row.deployment_chain,
    deployment_contract_address: row.deployment_contract_address,
    deployment_outcome: row.deployment_outcome,
  }));
  return makeNoopD1({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn().mockResolvedValue({
        results: sql.includes("FROM dex_deployment_outcomes") ? deploymentRows : evidenceRows,
      }),
    })),
  });
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

describe("loadDexLiquidityScores", () => {
  it("fails closed when publication identity changes during paginated reads", async () => {
    const row = liquidityRow({ publication_generation_id: "old" });
    let manifestReads = 0;
    const db = makeNoopD1({ prepare: vi.fn((sql: string) => {
      if (!sql.includes("score_components_json")) return { all: async () => ({ results: [{
        stablecoin_id: row.stablecoin_id,
        updated_at: row.updated_at,
        publication_generation_id: manifestReads++ === 0 ? "old" : "new",
      }] }) };
      return { bind: () => ({ all: async () => ({ results: [row] }) }) };
    }) });
    await expect(loadDexLiquidityScores(db)).rejects.toThrow("publication changed");
  });

  it("matches full snapshot quarantine and freshness across bounded pages without reading deployment census", async () => {
    const rows = Array.from({ length: 140 }, (_, index) => liquidityRow({
      stablecoin_id: `coin-${String(index).padStart(3, "0")}`,
      updated_at: index,
    }));
    rows[65] = { ...rows[65], coverage_confidence: null, updated_at: 10_000 };
    rows[130] = { ...rows[130], score_components_json: JSON.stringify({ exitRouteObservations: [{}] }), updated_at: 20_000 };
    const full = await loadDexLiquiditySnapshot(mockDb(rows));
    const pages: number[] = [];
    const db = makeNoopD1({
      prepare: vi.fn((sql: string) => {
        expect(sql).not.toContain("dex_deployment_outcomes");
        if (!sql.includes("score_components_json")) return {
          all: async () => ({ results: rows.map(({ stablecoin_id, updated_at, publication_generation_id }) => ({
            stablecoin_id, updated_at, publication_generation_id,
          })) }),
        };
        expect(sql).toContain("score_components_json");
        expect(sql).toContain("ORDER BY dl.stablecoin_id LIMIT ?");
        return { bind: (cursor: string, limit: number) => ({
          all: async () => {
            const results = rows.filter((row) => String(row.stablecoin_id) > cursor).slice(0, limit);
            pages.push(results.length);
            return { results };
          },
        }) };
      }),
    });
    const scores = await loadDexLiquidityScores(db);
    expect(scores).toEqual({
      map: Object.fromEntries(Object.entries(full.map).map(([id, row]) => [id, { liquidityScore: row.liquidityScore }])),
      latestUpdatedAt: full.latestUpdatedAt,
    });
    expect(pages).toEqual([64, 64, 12]);
    expect(scores.latestUpdatedAt).toBe(139);
  });
});

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
          trendworthy: true,
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

  it("loads execution payloads once per coin, never once per deployment, for both callers", async () => {
    const db = mockDb([
      liquidityRow({
        deployment_chain: "ethereum",
        deployment_contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        deployment_outcome: "observed_pools",
        score_components_json: "{}",
      }),
      liquidityRow({
        deployment_chain: "arbitrum",
        deployment_contract_address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        deployment_outcome: "verified_no_pools",
        score_components_json: "{}",
      }),
    ]);
    const snapshot = await loadDexLiquiditySnapshot(db);
    expect(await loadDexLiquidityMap(db)).toEqual(snapshot.map);
    const queries = vi.mocked(db.prepare).mock.calls.map(([sql]) => sql);
    for (const sql of queries) {
      expect(sql).toContain("state = 'published'");
      if (sql.includes("score_components_json")) {
        expect(sql).not.toContain("JOIN");
        expect(sql).not.toContain("dex_deployment_outcomes");
      } else {
        expect(sql).toContain("FROM dex_deployment_outcomes");
        expect(sql).not.toContain("score_components_json");
      }
    }
    expect(snapshot.map["usdc-circle"].deploymentCoverage).toEqual({
      observedPools: 1, verifiedNoPools: 1, providerInaccessible: 0,
    });
  });

  it("surfaces a missing mandatory deployment-outcomes table", async () => {
    const prepare = vi.fn((sql: string) => ({
      all: sql.includes("FROM dex_deployment_outcomes")
        ? vi.fn().mockRejectedValue(new Error("D1_ERROR: no such table: dex_deployment_outcomes"))
        : vi.fn().mockResolvedValue({ results: [liquidityRow()] }),
    }));
    const db = makeNoopD1({ prepare });

    await expect(loadDexLiquiditySnapshot(db)).rejects.toThrow(
      "D1_ERROR: no such table: dex_deployment_outcomes",
    );
    expect(prepare).toHaveBeenCalledTimes(2);
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
      coverageClass: "legacy",
      coverageConfidence: 0.5,
      liquidityEvidenceClass: "observed_unmeasured",
      hasMeasuredLiquidityEvidence: false,
      trendworthy: false,
      effectiveTvlUsd: 0,
      balanceMeasuredTvlUsd: 0,
      organicMeasuredTvlUsd: 0,
      methodologyVersion: "5.10",
    });
  });

  it("quarantines redemption-family observations without suppressing valid rows", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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

    const result = await loadDexLiquiditySnapshot(mockDb([
      liquidityRow({ score_components_json: JSON.stringify(scoreComponents) }),
      liquidityRow({ stablecoin_id: "valid" }),
    ]));

    expect(Object.keys(result.map)).toEqual(["valid"]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("usdc-circle"),
    );
    consoleError.mockRestore();
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
