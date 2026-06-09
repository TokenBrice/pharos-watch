import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import {
  buildProtocolCategoryLookupFromCachePayload,
  buildCoverageAuditOperatorQueue,
  identifyCoverageGaps,
  isHighConfidenceProtocolCategory,
  summarizeAdapterLifecycle,
} from "../yield-coverage-audit";
import { probeQuarantinedDeterministicAdapters } from "../yield-coverage-audit-quarantine";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { YieldAdapterLifecycleEntry } from "../yield-config-registry";
import type { DlPool } from "../yield-sync/types";

const mockFetchEvmUint256AtBlock = vi.mocked(fetchEvmUint256AtBlock);

afterEach(() => {
  mockFetchEvmUint256AtBlock.mockReset();
});

describe("buildProtocolCategoryLookupFromCachePayload", () => {
  it("parses raw cached DeFiLlama protocol payloads by normalized slug", () => {
    const lookup = buildProtocolCategoryLookupFromCachePayload({
      protocols: [
        { slug: "Aave-V3", category: " Lending " },
        { slug: "curve-dex", category: "Dexs" },
        { slug: "missing-category" },
        { slug: "blank-category", category: " " },
        { category: "CDP" },
      ],
    });

    expect(lookup).toEqual(new Map([
      ["aave-v3", "Lending"],
      ["curve-dex", "Dexs"],
    ]));
  });

  it("accepts the allowed lending categories for high-confidence recommendations", () => {
    expect(isHighConfidenceProtocolCategory("Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("CDP")).toBe(true);
    expect(isHighConfidenceProtocolCategory("RWA Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("Uncollateralized Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("Yield Aggregator")).toBe(false);
    expect(isHighConfidenceProtocolCategory(null)).toBe(false);
  });
});

describe("identifyCoverageGaps", () => {
  it("identifies high-TVL stablecoin pools not matched", () => {
    const dlPools: DlPool[] = [{
      pool: "unknown-pool", chain: "Ethereum", project: "new-protocol",
      symbol: "NEW_STABLE", tvlUsd: 50_000_000, apy: 5, apyBase: 5,
      apyReward: null, apyMean30d: 5, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.unmatchedHighTvlPools.length).toBe(1);
    expect(gaps.unmatchedHighTvlPools[0].pool).toBe("unknown-pool");
  });

  it("does not flag pools already covered", () => {
    const dlPools: DlPool[] = [{
      pool: "covered-pool", chain: "Ethereum", project: "aave-v3",
      symbol: "USDC", tvlUsd: 100_000_000, apy: 3, apyBase: 3,
      apyReward: null, apyMean30d: 3, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const gaps = identifyCoverageGaps(dlPools, new Set(["covered-pool"]));
    expect(gaps.unmatchedHighTvlPools.length).toBe(0);
  });

  it("identifies protocols not in allowlist", () => {
    const dlPools: DlPool[] = [{
      pool: "p1", chain: "Ethereum", project: "brand-new-protocol",
      symbol: "USDC", tvlUsd: 10_000_000, apy: 4, apyBase: 4,
      apyReward: null, apyMean30d: 4, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.missingProtocols.length).toBeGreaterThan(0);
    expect(gaps.missingProtocols[0].project).toBe("brand-new-protocol");
  });

  it("does not flag high-TVL pools on already-supported allowlisted protocols as unmatched gaps", () => {
    const dlPools: DlPool[] = [{
      pool: "aave-pool",
      chain: "Ethereum",
      project: "aave-v3",
      symbol: "USDC",
      tvlUsd: 100_000_000,
      apy: 3,
      apyBase: 3,
      apyReward: null,
      apyMean30d: 3,
      stablecoin: true,
      exposure: "single",
      underlyingTokens: null,
    }];

    const gaps = identifyCoverageGaps(dlPools, new Set(), new Set(["aave-v3"]));
    expect(gaps.unmatchedHighTvlPools).toEqual([]);
    expect(gaps.missingProtocols).toEqual([]);
  });

  it("recommends high-confidence protocols with >$10M TVL and 3+ pools", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "rising-protocol", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p2", chain: "Ethereum", project: "rising-protocol", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p3", chain: "Arbitrum", project: "rising-protocol", symbol: "USDC", tvlUsd: 3_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];
    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([["rising-protocol", "Lending"]]),
    );
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "rising-protocol",
        protocolCategory: "Lending",
        totalTvlUsd: 11_000_000,
        recommendedTier: "high-confidence",
      }),
    );
  });

  it("carries provided protocol category metadata on recommendations", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "category-lender", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p2", chain: "Ethereum", project: "category-lender", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p3", chain: "Arbitrum", project: "category-lender", symbol: "DAI", tvlUsd: 3_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([["category-lender", "Lending"]]),
    );

    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "category-lender",
        protocolCategory: "Lending",
        recommendedTier: "high-confidence",
      }),
    );
  });

  it("requires an allowed lending category before assigning high-confidence", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "aggregator-protocol", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p2", chain: "Ethereum", project: "aggregator-protocol", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p3", chain: "Arbitrum", project: "aggregator-protocol", symbol: "DAI", tvlUsd: 4_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p4", chain: "Ethereum", project: "missing-category-protocol", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p5", chain: "Ethereum", project: "missing-category-protocol", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p6", chain: "Arbitrum", project: "missing-category-protocol", symbol: "DAI", tvlUsd: 4_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([["aggregator-protocol", "Yield Aggregator"]]),
    );

    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "aggregator-protocol",
        protocolCategory: "Yield Aggregator",
        recommendedTier: "review-needed",
      }),
    );
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "missing-category-protocol",
        protocolCategory: null,
        recommendedTier: "review-needed",
      }),
    );
  });

  it("splits source-family adapter and lending allowlist recommendations", () => {
    const dlPools: DlPool[] = [
      { pool: "morpho-usdc", chain: "Ethereum", project: "morpho-blue", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "new-usdc", chain: "Ethereum", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      new Set(["morpho-blue"]),
      new Map([["new-lender", "Lending"]]),
    );

    expect(gaps.sourceFamilyAdapterRecommendations).toContainEqual(
      expect.objectContaining({
        project: "morpho-blue",
        totalTvlUsd: 12_000_000,
      }),
    );
    expect(gaps.lendingAllowlistRecommendations).toContainEqual(
      expect.objectContaining({
        project: "new-lender",
        protocolCategory: "Lending",
        totalTvlUsd: 12_000_000,
        sourceLinks: expect.arrayContaining([
          expect.objectContaining({ url: "https://yields.llama.fi/chart/new-usdc" }),
        ]),
        suggestedConfig: expect.objectContaining({
          targetFile: "worker/src/cron/yield-config-lending-protocols.ts",
          exportName: "LENDING_PROTOCOLS",
          anchor: "YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR",
          snippet: expect.stringContaining('"new-lender": { label: "New Lender" }'),
        }),
        promotionMetadata: expect.objectContaining({
          sourceQueue: "monthly-unmatched-high-tvl",
          sourceQueueField: "unmatchedHighTvlPools",
          minPoolTvlUsd: 5_000_000,
          queueQualifiedPoolCount: 1,
          passedCategoryGate: true,
          existingAllowlistMember: false,
        }),
      }),
    );
    expect(gaps.lendingAllowlistRecommendations).not.toContainEqual(
      expect.objectContaining({ project: "morpho-blue" }),
    );
  });

  it("drives lending allowlist recommendations from the high-TVL queue and category gate", () => {
    const dlPools: DlPool[] = [
      { pool: "queued-usdc", chain: "Ethereum", project: "queued-lender", symbol: "USDC", tvlUsd: 6_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregate-a", chain: "Ethereum", project: "aggregate-only-lender", symbol: "USDC", tvlUsd: 2_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregate-b", chain: "Base", project: "aggregate-only-lender", symbol: "USDC", tvlUsd: 2_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregate-c", chain: "Arbitrum", project: "aggregate-only-lender", symbol: "USDT", tvlUsd: 2_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregator-usdc", chain: "Ethereum", project: "yield-aggregator", symbol: "USDC", tvlUsd: 20_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "missing-category-usdc", chain: "Ethereum", project: "missing-category-lender", symbol: "USDC", tvlUsd: 20_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([
        ["queued-lender", "Lending"],
        ["aggregate-only-lender", "Lending"],
        ["yield-aggregator", "Yield Aggregator"],
      ]),
    );

    expect(gaps.lendingAllowlistRecommendations.map((row) => row.project)).toEqual(["queued-lender"]);
    expect(gaps.lendingAllowlistRecommendations[0]).toMatchObject({
      recommendedTier: "review-needed",
      promotionMetadata: expect.objectContaining({
        queueQualifiedPoolCount: 1,
        passedCategoryGate: true,
      }),
    });
    expect(gaps.protocolRecommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: "aggregate-only-lender" }),
        expect.objectContaining({ project: "yield-aggregator" }),
        expect.objectContaining({ project: "missing-category-lender" }),
      ]),
    );
  });

  it("recommends native exact pools for tracked yield-bearing symbols", () => {
    const dlPools: DlPool[] = [{
      pool: "susde-native",
      chain: "Ethereum",
      project: "ethena",
      symbol: "sUSDe",
      tvlUsd: 50_000_000,
      apy: 5,
      apyBase: 5,
      apyReward: null,
      apyMean30d: 5,
      stablecoin: true,
      exposure: "single",
      underlyingTokens: null,
    }];

    const gaps = identifyCoverageGaps(dlPools, new Set());

    expect(gaps.nativeExactPoolRecommendations).toContainEqual(
      expect.objectContaining({
        pool: "susde-native",
        stablecoinIds: expect.arrayContaining(["susde-ethena"]),
      }),
    );
  });

  it("marks review-needed for protocols with <$10M TVL or <3 pools", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "small-protocol", symbol: "USDC", tvlUsd: 6_000_000, apy: 3, apyBase: 3, apyReward: null, apyMean30d: 3, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "small-protocol",
        recommendedTier: "review-needed",
      }),
    );
  });

  it("builds a transient operator queue from headline gaps and recommendation candidates", () => {
    const dlPools: DlPool[] = [
      { pool: "susde-native", chain: "Ethereum", project: "ethena", symbol: "sUSDe", tvlUsd: 50_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "morpho-usdc", chain: "Ethereum", project: "morpho-blue", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "new-usdc", chain: "Ethereum", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];
    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      new Set(["morpho-blue"]),
      new Map([["new-lender", "Lending"]]),
    );

    const queue = buildCoverageAuditOperatorQueue({
      gaps,
      manifestMissingIds: ["missing-manifest"],
      yieldBearingMissingFromRankings: ["missing-ranking"],
    });

    expect(queue).toMatchObject({
      persistence: "deferred",
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
    });
    expect(queue.headlineGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "manifest-missing", actionHint: "accept" }),
        expect.objectContaining({ kind: "ranking-missing", actionHint: "watch" }),
      ]),
    );
    expect(queue.recommendationCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "native-exact-pool", pool: "susde-native" }),
        expect.objectContaining({ kind: "source-family-adapter", project: "morpho-blue" }),
        expect.objectContaining({
          kind: "lending-allowlist",
          project: "new-lender",
          protocolCategory: "Lending",
          examplePools: ["new-usdc"],
          examplePoolDetails: [
            expect.objectContaining({
              pool: "new-usdc",
              sourceUrl: "https://yields.llama.fi/chart/new-usdc",
            }),
          ],
          sourceLinks: expect.arrayContaining([
            expect.objectContaining({
              label: "DeFiLlama protocols category source",
              url: "https://api.llama.fi/protocols",
            }),
            expect.objectContaining({ url: "https://yields.llama.fi/chart/new-usdc" }),
          ]),
          suggestedConfig: expect.objectContaining({
            anchor: "YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR",
            snippet: '  "new-lender": { label: "New Lender" },',
          }),
          promotionMetadata: expect.objectContaining({
            sourceQueue: "monthly-unmatched-high-tvl",
            sourceQueueField: "unmatchedHighTvlPools",
            minPoolTvlUsd: 5_000_000,
            queueQualifiedPoolCount: 1,
            passedCategoryGate: true,
          }),
        }),
      ]),
    );
  });

  it("queues quarantine-ready-to-restore candidates as manual accept actions", () => {
    const queue = buildCoverageAuditOperatorQueue({
      gaps: {
        unmatchedHighTvlPools: [],
        missingProtocols: [],
        protocolRecommendations: [],
        nativeExactPoolRecommendations: [],
        sourceFamilyAdapterRecommendations: [],
        lendingAllowlistRecommendations: [],
      },
      manifestMissingIds: [],
      yieldBearingMissingFromRankings: [],
      quarantineReadyToRestore: [{
        stablecoinId: "reusd-re-protocol",
        code: "convert-to-assets-empty",
        since: "2026-03-15",
        nextReviewAt: "2026-07-09",
        sourceKey: "onchain:reusd-re-protocol",
        chain: "ethereum",
        contract: "0x1202f5c7B4b9E47a1A9837B26881B7C20112BD51",
        exchangeRate: 1.5,
      }],
    });

    expect(queue.recommendationCandidates).toContainEqual(
      expect.objectContaining({
        id: "quarantine-ready-to-restore:reusd-re-protocol",
        kind: "quarantine-ready-to-restore",
        title: "reusd-re-protocol",
        detail: "ethereum onchain:reusd-re-protocol probe returned 1.5",
        actionHint: "accept",
        stablecoinIds: ["reusd-re-protocol"],
      }),
    );
  });
});

describe("probeQuarantinedDeterministicAdapters", () => {
  const quarantinedAdapters = [
    {
      stablecoinId: "reusd-re-protocol",
      code: "convert-to-assets-empty",
      since: "2026-03-15",
      nextReviewAt: "2026-07-09",
    },
    {
      stablecoinId: "scrvusd-curve",
      code: "wrapper-not-yet-supported",
      since: "2026-04-11",
      nextReviewAt: "2026-07-09",
    },
  ];
  const chainRpcs = new Map<string, ChainRpcConfig>([
    ["ethereum", {
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example",
      explorerUrl: "https://etherscan.io",
    }],
  ]);

  it("skips configured probes when chain RPCs are unavailable", async () => {
    const result = await probeQuarantinedDeterministicAdapters({ quarantinedAdapters });

    expect(result.readyToRestore).toEqual([]);
    expect(result.summary).toEqual({
      configuredProbeCount: 1,
      attemptedCount: 0,
      readyToRestoreCount: 0,
      skippedCount: 1,
      failureCounts: {},
      skippedReason: "chain-rpcs-unavailable",
    });
    expect(mockFetchEvmUint256AtBlock).not.toHaveBeenCalled();
  });

  it("returns ready-to-restore candidates for nonzero probe rates inside the envelope", async () => {
    mockFetchEvmUint256AtBlock.mockResolvedValue(1_500_000_000_000_000_000n);

    const result = await probeQuarantinedDeterministicAdapters({
      quarantinedAdapters,
      chainRpcs,
    });

    expect(result.readyToRestore).toEqual([{
      stablecoinId: "reusd-re-protocol",
      code: "convert-to-assets-empty",
      since: "2026-03-15",
      nextReviewAt: "2026-07-09",
      sourceKey: "onchain:reusd-re-protocol",
      chain: "ethereum",
      contract: "0x1202f5c7B4b9E47a1A9837B26881B7C20112BD51",
      exchangeRate: 1.5,
    }]);
    expect(result.summary).toEqual({
      configuredProbeCount: 1,
      attemptedCount: 1,
      readyToRestoreCount: 1,
      skippedCount: 0,
      failureCounts: {},
    });
    expect(mockFetchEvmUint256AtBlock).toHaveBeenCalledTimes(1);
    expect(mockFetchEvmUint256AtBlock).toHaveBeenCalledWith(
      undefined,
      "0x1202f5c7B4b9E47a1A9837B26881B7C20112BD51",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://rpc.example"],
        timeoutMs: 6_000,
      }),
    );
  });

  it("rejects zero and above-envelope quarantine probe rates", async () => {
    for (const rawRate of [0n, 4_000_000_000_000_000_000n]) {
      mockFetchEvmUint256AtBlock.mockResolvedValueOnce(rawRate);

      const result = await probeQuarantinedDeterministicAdapters({
        quarantinedAdapters,
        chainRpcs,
      });

      expect(result.readyToRestore).toEqual([]);
      expect(result.summary).toEqual({
        configuredProbeCount: 1,
        attemptedCount: 1,
        readyToRestoreCount: 0,
        skippedCount: 0,
        failureCounts: { "out-of-envelope": 1 },
      });
    }
  });
});

describe("summarizeAdapterLifecycle", () => {
  const syntheticRegistry: Record<string, YieldAdapterLifecycleEntry> = {
    "alpha-active": { lifecycle: "active" },
    "beta-quarantined": {
      lifecycle: "quarantined",
      reason: {
        code: "convert-to-assets-empty",
        since: "2026-04-01",
        nextReviewAt: "2026-05-01",
        note: "needs protocol-specific reader",
      },
    },
    "gamma-gap": {
      lifecycle: "intentional-gap",
      reason: {
        code: "no-public-yield-source",
        since: "2026-03-10",
        note: "issuer publishes no APY oracle",
      },
    },
    "delta-experimental": {
      lifecycle: "experimental",
      reason: { code: "exploratory", since: "2026-05-15" },
    },
  };

  it("counts lifecycle states matching the synthetic registry", () => {
    const buckets = summarizeAdapterLifecycle(
      ["alpha-active", "beta-quarantined", "gamma-gap", "delta-experimental", "epsilon-unknown"],
      syntheticRegistry,
    );

    expect(buckets.lifecycleSummary).toEqual({
      active: 2, // alpha + epsilon (unknown defaults to active)
      quarantined: 1,
      intentionalGap: 1,
      experimental: 1,
    });
  });

  it("surfaces quarantined adapters with their structured reason", () => {
    const buckets = summarizeAdapterLifecycle(
      ["alpha-active", "beta-quarantined"],
      syntheticRegistry,
    );

    expect(buckets.quarantinedAdapters).toContainEqual({
      stablecoinId: "beta-quarantined",
      code: "convert-to-assets-empty",
      since: "2026-04-01",
      nextReviewAt: "2026-05-01",
      note: "needs protocol-specific reader",
    });
  });

  it("surfaces intentional gaps in their own bucket", () => {
    const buckets = summarizeAdapterLifecycle(["gamma-gap"], syntheticRegistry);

    expect(buckets.intentionalGaps).toContainEqual({
      stablecoinId: "gamma-gap",
      code: "no-public-yield-source",
      since: "2026-03-10",
      nextReviewAt: undefined,
      note: "issuer publishes no APY oracle",
    });
    expect(buckets.quarantinedAdapters).toEqual([]);
  });

  it("treats legacy/untyped IDs as active and leaves them out of buckets", () => {
    const buckets = summarizeAdapterLifecycle(
      ["only-legacy-id"],
      {}, // empty registry: every ID falls through to the default
    );

    expect(buckets.lifecycleSummary).toEqual({
      active: 1,
      quarantined: 0,
      intentionalGap: 0,
      experimental: 0,
    });
    expect(buckets.quarantinedAdapters).toEqual([]);
    expect(buckets.intentionalGaps).toEqual([]);
  });
});
