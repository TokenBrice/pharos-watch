import { describe, expect, it } from "vitest";
import { buildCoverageAuditOperatorQueue, identifyCoverageGaps } from "../yield-coverage-audit";
import type { DlPool } from "../yield-sync/types";

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
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "rising-protocol",
        totalTvlUsd: 11_000_000,
        recommendedTier: "high-confidence",
      }),
    );
  });

  it("splits source-family adapter and lending allowlist recommendations", () => {
    const dlPools: DlPool[] = [
      { pool: "morpho-usdc", chain: "Ethereum", project: "morpho-blue", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "new-usdc", chain: "Ethereum", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(dlPools, new Set(), new Set(["morpho-blue"]));

    expect(gaps.sourceFamilyAdapterRecommendations).toContainEqual(
      expect.objectContaining({
        project: "morpho-blue",
        totalTvlUsd: 12_000_000,
      }),
    );
    expect(gaps.lendingAllowlistRecommendations).toContainEqual(
      expect.objectContaining({
        project: "new-lender",
        totalTvlUsd: 12_000_000,
      }),
    );
    expect(gaps.lendingAllowlistRecommendations).not.toContainEqual(
      expect.objectContaining({ project: "morpho-blue" }),
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
    const gaps = identifyCoverageGaps(dlPools, new Set(), new Set(["morpho-blue"]));

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
        expect.objectContaining({ kind: "lending-allowlist", project: "new-lender" }),
      ]),
    );
  });
});
