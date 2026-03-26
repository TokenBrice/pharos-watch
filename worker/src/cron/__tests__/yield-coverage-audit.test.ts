import { describe, expect, it } from "vitest";
import { identifyCoverageGaps } from "../yield-coverage-audit";
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
});
