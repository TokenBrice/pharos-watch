import { describe, it, expect, vi } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  PRICE_DERIVED_STALE_THRESHOLD_MS,
  RATE_DERIVED_STALE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
  SLOW_NAV_SOURCE_STALE_THRESHOLD_MS,
  COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
  LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
  DETERMINISTIC_APY_SANITY_MAX,
  computeApyFromRate,
  computeApyFromPrice,
  computePYS,
  computeYieldStability,
  computeApyVarianceScore,
  derivePysNullReason,
  detectWarningSignals,
  getRankingStaleThresholdMs,
  getComparisonAnchorStaleThresholdMs,
  isDeterministicApyWithinSanityBounds,
  matchAllDlPools,
  findBestLendingPool,
  isBlockedYieldOpportunitySource,
} from "../yield-helpers";
import { computeTvlWeightedMedianApy } from "../yield-sync/rankings";
import { parseYieldWarningSignals as parseWarningSignals } from "../../lib/yield-utils";
import { LENDING_PROTOCOL_ALLOWLIST } from "../yield-config";

// computeTvlWeightedMedianApy is internal to sync-yield-data.ts - tested via integration
describe("STALE_THRESHOLD_MS", () => {
  it("tracks three sync-yield-data intervals in milliseconds", () => {
    expect(STALE_THRESHOLD_MS).toBe(CRON_INTERVALS["sync-yield-data"] * 3 * 1000);
  });

  it("gives supplemental families one four-hour cycle plus buffer before stale", () => {
    expect(SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS).toBe(CRON_INTERVALS["sync-yield-supplemental"] * 1.5 * 1000);
  });

  it("marks comparison anchors stale after the conservative two-week window", () => {
    expect(COMPARISON_ANCHOR_STALE_THRESHOLD_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe("getRankingStaleThresholdMs", () => {
  it("keeps price-derived rows on the daily snapshot threshold", () => {
    expect(getRankingStaleThresholdMs("price-derived", "price-derived")).toBe(PRICE_DERIVED_STALE_THRESHOLD_MS);
  });

  it("uses the daily benchmark window for rate-derived rows", () => {
    expect(getRankingStaleThresholdMs("rate-derived", "rate-derived")).toBe(RATE_DERIVED_STALE_THRESHOLD_MS);
  });

  it("uses the supplemental threshold for protocol-api rows", () => {
    expect(getRankingStaleThresholdMs("protocol-api", "protocol-api:pendle:ethereum:0xpool")).toBe(
      SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
    );
  });

  it("matches slow protocol-native NAV sources to their adapter freshness window", () => {
    expect(getRankingStaleThresholdMs("protocol-api", "protocol-api:hashnote-usyc")).toBe(
      SLOW_NAV_SOURCE_STALE_THRESHOLD_MS,
    );
    expect(getRankingStaleThresholdMs("protocol-api", "protocol-api:midas-mmev-nav-oracle")).toBe(
      SLOW_NAV_SOURCE_STALE_THRESHOLD_MS,
    );
    expect(getRankingStaleThresholdMs("protocol-api", "protocol-api:re-protocol-reusd")).toBe(
      SLOW_NAV_SOURCE_STALE_THRESHOLD_MS,
    );
    expect(getRankingStaleThresholdMs("defillama", "protocol-api:hashnote-usyc")).toBe(STALE_THRESHOLD_MS);
    expect(SLOW_NAV_SOURCE_STALE_THRESHOLD_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("uses the supplemental threshold for optional onchain source keys", () => {
    expect(getRankingStaleThresholdMs("onchain", "aave-v3-onchain:ethereum:0xasset")).toBe(
      SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
    );
    expect(getRankingStaleThresholdMs("onchain", "compound-v3:ethereum:0xasset")).toBe(
      SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
    );
  });

  it("keeps deterministic onchain rows on the hourly threshold", () => {
    expect(getRankingStaleThresholdMs("onchain", "onchain:sky-ssr")).toBe(STALE_THRESHOLD_MS);
  });
});

describe("getComparisonAnchorStaleThresholdMs", () => {
  it("uses the full intentional anchor window for price and long-horizon NAV sources", () => {
    expect(getComparisonAnchorStaleThresholdMs("price-derived", "price-derived")).toBe(
      LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
    );
    expect(getComparisonAnchorStaleThresholdMs("protocol-api", "protocol-api:midas-mmev-nav-oracle")).toBe(
      LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
    );
  });

  it("retains the two-week guard for ordinary exchange-rate anchors", () => {
    expect(getComparisonAnchorStaleThresholdMs("onchain", "onchain:test")).toBe(
      COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
    );
  });
});

describe("computeApyFromRate", () => {
  it("returns 0 for identical rates", () => {
    expect(computeApyFromRate(1.05, 1.05, 30)).toBe(0);
  });

  it("computes positive APY for increasing rate", () => {
    const apy = computeApyFromRate(1.001, 1.0, 1);
    expect(apy).toBeGreaterThan(0);
  });

  it("returns 0 for non-positive inputs", () => {
    expect(computeApyFromRate(0, 1, 1)).toBe(0);
    expect(computeApyFromRate(1, 0, 1)).toBe(0);
    expect(computeApyFromRate(1, 1, 0)).toBe(0);
  });

  it("returns negative APY for decreasing rate", () => {
    const apy = computeApyFromRate(0.99, 1.0, 7);
    expect(apy).toBeLessThan(0);
  });

  it("computes expected APY for a 7-day vault rate change", () => {
    // Rate went from 1.0 to 1.001 over 7 days
    // (1.001)^(365.25/7) - 1 ≈ 0.05343 → 5.34%
    const apy = computeApyFromRate(1.001, 1.0, 7);
    expect(apy).toBeCloseTo(5.34, 0);
  });

  it("aliases computeApyFromPrice", () => {
    const rateApy = computeApyFromRate(1.05, 1.0, 30);
    const priceApy = computeApyFromPrice(1.05, 1.0, 30);
    expect(rateApy).toBe(priceApy);
  });

  it("flags extreme deterministic annualization as outside the sanity envelope", () => {
    const apy = computeApyFromRate(1.02, 1.0, 3);
    expect(apy).toBeGreaterThan(DETERMINISTIC_APY_SANITY_MAX);
    expect(isDeterministicApyWithinSanityBounds(apy)).toBe(false);
    expect(isDeterministicApyWithinSanityBounds(5)).toBe(true);
    expect(isDeterministicApyWithinSanityBounds(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("computePYS", () => {
  it("returns 0 for zero APY", () => {
    expect(computePYS({ apy30d: 0, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 10 })).toBe(0);
  });

  it("returns higher score for higher APY", () => {
    const low = computePYS({ apy30d: 2, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 10 });
    const high = computePYS({ apy30d: 8, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 10 });
    expect(high).toBeGreaterThan(low);
  });

  it("returns higher score when the same APY clears a lower benchmark", () => {
    const usdLike = computePYS({ apy30d: 4, benchmarkRate: 4.5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 10 });
    const chfLike = computePYS({ apy30d: 4, benchmarkRate: 0, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 10 });
    expect(chfLike).toBeGreaterThan(usdLike);
  });

  it("returns higher score for higher safety score", () => {
    const risky = computePYS({ apy30d: 5, safetyScore: 30, apyVarianceScore: 0.1, scalingFactor: 10 });
    const safe = computePYS({ apy30d: 5, safetyScore: 90, apyVarianceScore: 0.1, scalingFactor: 10 });
    expect(safe).toBeGreaterThan(risky);
  });

  it("caps at 100", () => {
    const result = computePYS({ apy30d: 100, safetyScore: 100, apyVarianceScore: 0, scalingFactor: 100 });
    expect(result).toBeLessThanOrEqual(100);
  });

  it("matches the benchmark-aware source-risk worked example", () => {
    const result = computePYS({
      apy30d: 8.4,
      benchmarkRate: 4.25,
      safetyScore: 72,
      sourceRiskPenalty: 1.2,
      apyVarianceScore: 0.18,
      scalingFactor: 8,
    });
    expect(result).toBe(27);
  });
});

describe("derivePysNullReason", () => {
  it("returns null when inputs yield a positive PYS", () => {
    expect(
      derivePysNullReason({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 8 }),
    ).toBeNull();
  });

  it("flags apy-non-positive for zero or negative apy30d", () => {
    expect(
      derivePysNullReason({ apy30d: 0, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 8 }),
    ).toBe("apy-non-positive");
    expect(
      derivePysNullReason({ apy30d: -1, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 8 }),
    ).toBe("apy-non-positive");
  });

  it("flags missing-inputs when apy30d is not finite", () => {
    expect(
      derivePysNullReason({ apy30d: Number.NaN, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 8 }),
    ).toBe("missing-inputs");
  });

  it("flags scaling-invalid for zero or non-finite scaling factor", () => {
    expect(
      derivePysNullReason({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 0 }),
    ).toBe("scaling-invalid");
    expect(
      derivePysNullReason({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: Number.NaN }),
    ).toBe("scaling-invalid");
  });

  it("flags effective-yield-non-positive when benchmark wipes apy", () => {
    // benchmarkSpread = apy30d - benchmarkRate = 0.1 - 100 = -99.9
    // benchmarkAdjustment = -99.9 * 0.25 = -24.975
    // effectiveYield = max(0, apy30d + adjustment) = max(0, 0.1 - 24.975) = 0
    expect(
      derivePysNullReason({
        apy30d: 0.1,
        benchmarkRate: 100,
        safetyScore: 80,
        apyVarianceScore: 0.1,
        scalingFactor: 8,
      }),
    ).toBe("effective-yield-non-positive");
  });
});

describe("computeYieldStability", () => {
  it("returns null for fewer than 2 samples", () => {
    expect(computeYieldStability([])).toBeNull();
    expect(computeYieldStability([5])).toBeNull();
  });

  it("returns 1 for perfectly stable yields", () => {
    expect(computeYieldStability([5, 5, 5, 5])).toBe(1);
  });

  it("returns value between 0 and 1 for normal variation", () => {
    const stability = computeYieldStability([3, 4, 5, 6, 7]);
    expect(stability).toBeGreaterThan(0);
    expect(stability).toBeLessThanOrEqual(1);
  });

  it("returns lower stability for higher variance", () => {
    const stable = computeYieldStability([5, 5.1, 4.9, 5.05])!;
    const volatile = computeYieldStability([1, 10, 2, 9])!;
    expect(stable).toBeGreaterThan(volatile);
  });

  it("returns null when CV is Infinity (tiny mean, extreme variance)", () => {
    // mean = 5e-10 (above 1e-10 guard), variance overflows to Infinity → cv = Infinity
    expect(computeYieldStability([1e-9, 1e200, -1e200, 1e-9])).toBeNull();
  });
});

describe("computeApyVarianceScore", () => {
  it("returns null for fewer than 2 samples", () => {
    expect(computeApyVarianceScore([])).toBeNull();
    expect(computeApyVarianceScore([5])).toBeNull();
  });

  it("returns null for near-zero mean (insufficient signal)", () => {
    expect(computeApyVarianceScore([0, 0, 0])).toBeNull();
    expect(computeApyVarianceScore([1e-11, 0, 1e-11, 0])).toBeNull();
  });

  it("returns 0 for constant samples", () => {
    expect(computeApyVarianceScore([5, 5, 5])).toBe(0);
  });

  it("returns higher score for more variance", () => {
    const low = computeApyVarianceScore([5, 5.1, 4.9])!;
    const high = computeApyVarianceScore([1, 10, 1, 10])!;
    expect(high).toBeGreaterThan(low);
  });

  it("caps at 1", () => {
    const result = computeApyVarianceScore([0.001, 100, 0.001, 100]);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("returns null when CV is Infinity", () => {
    // Same mechanism: mean bypasses near-zero guard but variance overflows
    expect(computeApyVarianceScore([1e-9, 1e200, -1e200, 1e-9])).toBeNull();
  });
});

describe("detectWarningSignals", () => {
  const base = {
    currentApy: 5,
    apy30d: 5,
    apyReward: null,
    medianApy: 5,
    sourceTvlUsd: null,
    prevTvlUsd: null,
  };

  it("returns empty array for stable conditions", () => {
    expect(detectWarningSignals(base)).toEqual([]);
  });

  it("detects yield-spike when current > 2x 30d avg", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 11, apy30d: 5 });
    expect(signals).toContain("yield-spike");
  });

  it("detects yield-divergence when current > 3x median", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 16, medianApy: 5 });
    expect(signals).toContain("yield-divergence");
  });

  it("detects negative-trend when current < 70% of 30d avg", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 3, apy30d: 5 });
    expect(signals).toContain("negative-trend");
  });

  it("detects reward-heavy when reward > 80% of total", () => {
    const signals = detectWarningSignals({ ...base, apyReward: 4.5 });
    expect(signals).toContain("reward-heavy");
  });

  it("detects tvl-outflow when TVL drops >20%", () => {
    const signals = detectWarningSignals({ ...base, sourceTvlUsd: 70_000_000, prevTvlUsd: 100_000_000 });
    expect(signals).toContain("tvl-outflow");
  });

  it("does not flag tvl-outflow when prevTvlUsd is zero", () => {
    const signals = detectWarningSignals({ ...base, sourceTvlUsd: 0, prevTvlUsd: 0 });
    expect(signals).not.toContain("tvl-outflow");
  });

  it("detects zero-yield when current is 0 but 30d average > 0.5%", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 0, apy30d: 2 });
    expect(signals).toContain("zero-yield");
  });

  it("does not flag zero-yield when 30d average is also near zero", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 0, apy30d: 0.3 });
    expect(signals).not.toContain("zero-yield");
  });

  it("does not flag yield-spike for low-APY coins below absolute floor", () => {
    // 0.5% → 1.1% is a 2.2x ratio but too small to matter
    const signals = detectWarningSignals({ ...base, currentApy: 1.1, apy30d: 0.5, medianApy: 5 });
    expect(signals).not.toContain("yield-spike");
  });

  it("still flags yield-spike for meaningful APY levels above floor", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 11, apy30d: 5, medianApy: 5 });
    expect(signals).toContain("yield-spike");
  });

  it("does not flag negative-trend for very low baseline APY", () => {
    // 0.8% → 0.5% is a 37.5% drop but too small to matter
    const signals = detectWarningSignals({ ...base, currentApy: 0.5, apy30d: 0.8, medianApy: 5 });
    expect(signals).not.toContain("negative-trend");
  });

  it("can return multiple signals simultaneously", () => {
    const signals = detectWarningSignals({
      currentApy: 50,
      apy30d: 5,
      apyReward: 45,
      medianApy: 5,
      sourceTvlUsd: 50_000_000,
      prevTvlUsd: 100_000_000,
    });
    expect(signals.length).toBeGreaterThanOrEqual(3);
  });

  it("does not flag yield-spike at exact 2x threshold (requires exceeding)", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 10, apy30d: 5 });
    expect(signals).not.toContain("yield-spike");
  });

  it("flags yield-spike just above 2x threshold", () => {
    const signals = detectWarningSignals({ ...base, currentApy: 10.01, apy30d: 5 });
    expect(signals).toContain("yield-spike");
  });

  it("handles negative currentApy without crashing", () => {
    const signals = detectWarningSignals({ ...base, currentApy: -1, apy30d: 5 });
    expect(signals).toContain("negative-trend");
    expect(signals).not.toContain("yield-spike");
  });

  it("returns exact expected signals for all-trigger input", () => {
    const signals = detectWarningSignals({
      currentApy: 50,
      apy30d: 5,
      apyReward: 45,
      medianApy: 5,
      sourceTvlUsd: 50_000_000,
      prevTvlUsd: 100_000_000,
    });
    expect(signals).toEqual(
      expect.arrayContaining(["yield-spike", "yield-divergence", "reward-heavy", "tvl-outflow"]),
    );
    // negative-trend should NOT fire: 50 > 5*0.7
    expect(signals).not.toContain("negative-trend");
  });
});

describe("matchAllDlPools", () => {
  it("matches Layer 1 native pool by UUID from poolMap", () => {
    const poolMap = { "usde-ethena": "uuid-123" };
    const dlPools = [
      {
        pool: "uuid-123",
        symbol: "USDe",
        stablecoin: true,
        exposure: "single",
        tvlUsd: 5_000_000_000,
        apy: 12.4,
        apyBase: 10.2,
        apyReward: 2.2,
      },
      {
        pool: "uuid-other",
        symbol: "USDe",
        stablecoin: true,
        exposure: "single",
        tvlUsd: 100_000,
        apy: 3.0,
        apyBase: 3.0,
        apyReward: null,
      },
    ];

    const result = matchAllDlPools("usde-ethena", "USDe", dlPools, poolMap, {});
    expect(result).toHaveLength(1);
    expect(result[0].pool).toBe("uuid-123");
    expect(result[0].apy).toBe(12.4);
  });

  it("excludes Layer 1 pool with exposure !== single", () => {
    const poolMap = { "test-coin": "uuid-multi" };
    const dlPools = [
      {
        pool: "uuid-multi",
        symbol: "TEST",
        stablecoin: true,
        exposure: "multi",
        tvlUsd: 1_000_000,
        apy: 5.0,
        apyBase: 5.0,
        apyReward: null,
      },
    ];

    const result = matchAllDlPools("test-coin", "TEST", dlPools, poolMap, {});
    expect(result).toHaveLength(0);
  });

  it("matches Layer 2 variant wrapper pool alongside Layer 1", () => {
    const poolMap = { "usde-ethena": "uuid-native" };
    const variantMap = { "usde-ethena": { variantSymbol: "sUSDe" } };
    const dlPools = [
      {
        pool: "uuid-native",
        symbol: "USDe",
        stablecoin: true,
        exposure: "single",
        tvlUsd: 5_000_000_000,
        apy: 0,
        apyBase: 0,
        apyReward: null,
      },
      {
        pool: "uuid-wrapper",
        symbol: "sUSDe",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 3_000_000_000,
        apy: 12.4,
        apyBase: 12.4,
        apyReward: null,
      },
    ];

    const result = matchAllDlPools("usde-ethena", "USDe", dlPools, poolMap, variantMap);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.pool)).toContain("uuid-native");
    expect(result.map((r) => r.pool)).toContain("uuid-wrapper");
  });

  it("deduplicates when Layer 1 and Layer 2 resolve to the same pool UUID", () => {
    const poolMap = { "test-coin": "uuid-same" };
    const variantMap = { "test-coin": { variantSymbol: "sTEST" } };
    const dlPools = [
      {
        pool: "uuid-same",
        symbol: "sTEST",
        stablecoin: true,
        exposure: "single",
        tvlUsd: 1_000_000,
        apy: 5.0,
        apyBase: 5.0,
        apyReward: null,
      },
    ];

    const result = matchAllDlPools("test-coin", "TEST", dlPools, poolMap, variantMap);
    expect(result).toHaveLength(1);
  });

  it("does not cross-contaminate variant symbols that are prefixes of other symbols", () => {
    // sUSDa must NOT match sUSDai — that's a different token
    const variantMap = { "usda-avalon": { variantSymbol: "sUSDa" } };
    const dlPools = [
      {
        pool: "uuid-susdai",
        symbol: "sUSDai",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 200_000_000,
        apy: 6.77,
        apyBase: 6.77,
        apyReward: null,
      },
      {
        pool: "uuid-susda",
        symbol: "sUSDa",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 50_000_000,
        apy: 4.5,
        apyBase: 4.5,
        apyReward: null,
      },
    ];

    const result = matchAllDlPools("usda-avalon", "USDa", dlPools, {}, variantMap);
    expect(result).toHaveLength(1);
    expect(result[0].pool).toBe("uuid-susda");
    expect(result[0].apy).toBe(4.5);
  });

  it("uses variant chain and address before symbol fallback", () => {
    const variantMap = {
      "test-coin": {
        variantSymbol: "sTEST",
        variantChain: "ethereum",
        variantAddress: "0xdef",
      },
    };
    const dlPools = [
      {
        pool: "uuid-wrong-chain",
        chain: "Base",
        symbol: "sTEST",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 50_000_000,
        apy: 6,
        apyBase: 6,
        apyReward: null,
        underlyingTokens: ["0xdef"],
      },
      {
        pool: "uuid-correct",
        chain: "Ethereum",
        symbol: "sTEST",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 10_000_000,
        apy: 5,
        apyBase: 5,
        apyReward: null,
        underlyingTokens: ["0xdef"],
      },
    ];

    const result = matchAllDlPools("test-coin", "TEST", dlPools, {}, variantMap);
    expect(result).toHaveLength(1);
    expect(result[0].pool).toBe("uuid-correct");
  });

  it("uses variantProject to disambiguate same-address wrapper venues", () => {
    const variantMap = {
      "test-coin": {
        variantSymbol: "sTEST",
        variantChain: "ethereum",
        variantAddress: "0xdef",
        variantProject: "native-wrapper",
      },
    };
    const dlPools = [
      {
        pool: "uuid-native",
        chain: "Ethereum",
        project: "native-wrapper",
        symbol: "sTEST",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 40_000_000,
        apy: 5.2,
        apyBase: 5.2,
        apyReward: null,
        underlyingTokens: ["0xdef"],
      },
      {
        pool: "uuid-lending",
        chain: "Ethereum",
        project: "morpho-v1",
        symbol: "sTEST",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 25_000_000,
        apy: 6.1,
        apyBase: 6.1,
        apyReward: null,
        underlyingTokens: ["0xdef"],
      },
    ];

    const result = matchAllDlPools("test-coin", "TEST", dlPools, {}, variantMap);
    expect(result).toHaveLength(1);
    expect(result[0].pool).toBe("uuid-native");
    expect(result[0].apy).toBe(5.2);
  });

  it("skips ambiguous variant symbol matches when no stronger identity exists", () => {
    const variantMap = { "test-coin": { variantSymbol: "sTEST", variantChain: "ethereum" } };
    const dlPools = [
      {
        pool: "uuid-a",
        chain: "Ethereum",
        symbol: "sTEST",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 10_000_000,
        apy: 5,
        apyBase: 5,
        apyReward: null,
      },
      {
        pool: "uuid-b",
        chain: "Ethereum",
        symbol: "sTEST",
        stablecoin: false,
        exposure: "single",
        tvlUsd: 9_000_000,
        apy: 4,
        apyBase: 4,
        apyReward: null,
      },
    ];

    const result = matchAllDlPools("test-coin", "TEST", dlPools, {}, variantMap);
    expect(result).toEqual([]);
  });

  it("returns empty array when dlPools is empty", () => {
    const result = matchAllDlPools("test-coin", "TEST", [], { "test-coin": "uuid-1" }, {});
    expect(result).toHaveLength(0);
  });

  it("falls through to symbol match when static map UUID is missing from DL pools", () => {
    const poolMap = { "test-coin": "missing-uuid-123" };
    const dlPools = [
      {
        pool: "other-uuid",
        symbol: "TEST",
        stablecoin: true,
        exposure: "single",
        tvlUsd: 1_000_000,
        apy: 5.0,
        apyBase: 5.0,
        apyReward: null,
      },
    ];

    const result = matchAllDlPools("test-coin", "TEST", dlPools, poolMap, {});
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].pool).toBe("other-uuid");
  });

  it("skips Layer 3 symbol fallback for symbols shorter than 4 chars", () => {
    const pools = [
      { pool: "p1", symbol: "USDH", project: "test", tvlUsd: 5e6, apy: 3, apyBase: 3, apyReward: null, exposure: "single", stablecoin: true },
      { pool: "p2", symbol: "USDT", project: "test", tvlUsd: 10e6, apy: 2, apyBase: 2, apyReward: null, exposure: "single", stablecoin: true },
    ];
    // "USD" is 3 chars and should not match anything through fallback symbol matching.
    const result = matchAllDlPools("no-static-match", "USD", pools, {}, {});
    expect(result).toHaveLength(0);
  });

  it("does not accept Layer 3 substring-only symbol matches", () => {
    const pools = [
      {
        pool: "p1",
        symbol: "FEUSDH",
        project: "test",
        tvlUsd: 5e6,
        apy: 3,
        apyBase: 3,
        apyReward: null,
        exposure: "single",
        stablecoin: true,
      },
    ];

    const result = matchAllDlPools("usdh-test", "USDH", pools, {}, {});
    expect(result).toHaveLength(0);
  });

  it("keeps Layer 3 wrapper matches when the underlying token address corroborates identity", () => {
    const pools = [
      {
        pool: "p1",
        symbol: "FEUSDH",
        project: "test",
        tvlUsd: 5e6,
        apy: 3,
        apyBase: 3,
        apyReward: null,
        exposure: "single",
        stablecoin: true,
        underlyingTokens: ["0x111111a1a0667d36bd57c0a9f569b98057111111"],
      },
    ];

    const result = matchAllDlPools("usdh-test", "USDH", pools, {}, {}, {
      contractAddresses: ["0x111111A1A0667d36Bd57c0A9f569b98057111111"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.pool).toBe("p1");
  });
});

describe("findBestLendingPool", () => {
  const allowlist = new Set(["aave-v3", "compound-v3"]);

  const pools = [
    { pool: "p1", symbol: "USDT", project: "aave-v3", tvlUsd: 10_000_000, apy: 3.5, apyBase: 3.0, apyReward: 0.5, stablecoin: true, exposure: "single" },
    { pool: "p2", symbol: "USDT", project: "compound-v3", tvlUsd: 20_000_000, apy: 3.0, apyBase: 3.0, apyReward: null, stablecoin: true, exposure: "single" },
    { pool: "p3", symbol: "USDT", project: "unknown-dex", tvlUsd: 50_000_000, apy: 10.0, apyBase: null, apyReward: null, stablecoin: true, exposure: "single" },
    { pool: "p4", symbol: "ETH", project: "aave-v3", tvlUsd: 100_000_000, apy: 2.0, apyBase: 2.0, apyReward: null, stablecoin: false, exposure: "single" },
  ];

  it("returns highest-TVL pool from allowlisted protocols", () => {
    const result = findBestLendingPool("USDT", pools, allowlist);
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("p2");
    expect(result!.tvlUsd).toBe(20_000_000);
  });

  it("returns null when no matching pools found", () => {
    const result = findBestLendingPool("DAI", pools, allowlist);
    expect(result).toBeNull();
  });

  it("ignores pools not in allowlist", () => {
    const result = findBestLendingPool("USDT", pools, allowlist);
    expect(result!.project).not.toBe("unknown-dex");
  });

  it("ignores non-stablecoin pools", () => {
    const result = findBestLendingPool("ETH", pools, allowlist);
    expect(result).toBeNull();
  });

  it("is case-insensitive on symbol matching", () => {
    const result = findBestLendingPool("usdt", pools, allowlist);
    expect(result).not.toBeNull();
  });

  it("falls back to underlying token address when symbol does not match", () => {
    const poolsWithUnderlying = [
      ...pools,
      {
        pool: "p5",
        symbol: "FEUSDH",
        project: "aave-v3",
        tvlUsd: 12_000_000,
        apy: 4.2,
        apyBase: 4.2,
        apyReward: null,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: ["0x111111a1a0667d36bd57c0a9f569b98057111111"],
      },
    ];

    const result = findBestLendingPool("USDH", poolsWithUnderlying, allowlist, {
      contractAddresses: ["0x111111A1A0667d36Bd57c0A9f569b98057111111"],
    });
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("p5");
  });

  it("prefers address match over exact symbol when both are available", () => {
    const poolsWithUnderlying = [
      ...pools,
      {
        pool: "p5",
        symbol: "USDH",
        project: "aave-v3",
        tvlUsd: 5_000_000,
        apy: 3.4,
        apyBase: 3.4,
        apyReward: null,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: ["0xabc"],
      },
      {
        pool: "p6",
        symbol: "FEUSDH",
        project: "aave-v3",
        tvlUsd: 25_000_000,
        apy: 4.8,
        apyBase: 4.8,
        apyReward: null,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: ["0xabc"],
      },
    ];

    const result = findBestLendingPool("USDH", poolsWithUnderlying, allowlist, {
      contractAddresses: ["0xAbC"],
    });
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("p6");
  });

  it("applies optional min APY and TVL quality gates", () => {
    const result = findBestLendingPool("USDT", pools, allowlist, { minApy: 3.1, minTvlUsd: 15_000_000 });
    expect(result).toBeNull();
  });

  it("returns null when symbol-only matching is explicitly disallowed", () => {
    const result = findBestLendingPool("USDT", pools, allowlist, { allowSymbolMatch: false });
    expect(result).toBeNull();
  });

  it("does not reuse pools reserved for explicit overrides", () => {
    const result = findBestLendingPool("USDT", pools, allowlist, {
      reservedPoolIds: new Set(["p2"]),
    });
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("p1");
  });

  it("filters caller-provided blocked pools before selecting the highest TVL match", () => {
    const result = findBestLendingPool("USDT", pools, allowlist, {
      isBlockedPool: (pool) => pool.pool === "p2",
    });
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("p1");
  });

  it("skips blocked USR/Resolv lending venues", () => {
    const result = findBestLendingPool(
      "USDC",
      [
        {
          pool: "blocked",
          symbol: "USDC",
          project: "aave-v3",
          poolMeta: "Resolv USDC",
          tvlUsd: 50_000_000,
          apy: 8,
          apyBase: 8,
          apyReward: null,
          stablecoin: true,
          exposure: "single",
        },
        {
          pool: "safe",
          symbol: "USDC",
          project: "aave-v3",
          poolMeta: "Core USDC",
          tvlUsd: 5_000_000,
          apy: 4,
          apyBase: 4,
          apyReward: null,
          stablecoin: true,
          exposure: "single",
        },
      ],
      allowlist,
    );

    expect(result).not.toBeNull();
    expect(result!.pool).toBe("safe");
  });
});

describe("isBlockedYieldOpportunitySource", () => {
  it("matches Resolv and USR aliases", () => {
    expect(isBlockedYieldOpportunitySource({ yieldSource: "Morpho: Resolv USDC" })).toBe(true);
    expect(isBlockedYieldOpportunitySource({ yieldSource: "Vault using stUSR" })).toBe(true);
    expect(isBlockedYieldOpportunitySource({ poolMeta: "wstUSR market" })).toBe(true);
  });

  it("does not block unrelated venues", () => {
    expect(isBlockedYieldOpportunitySource({ yieldSource: "Aave v3 (ethereum)" })).toBe(false);
    expect(isBlockedYieldOpportunitySource({ poolMeta: "Core USDC" })).toBe(false);
  });
});

describe("computeTvlWeightedMedianApy", () => {
  it("returns 0 for empty input", () => {
    expect(computeTvlWeightedMedianApy([])).toBe(0);
  });

  it("returns 0 when all rows have null TVL", () => {
    expect(computeTvlWeightedMedianApy([
      { apy_30d: 5, source_tvl_usd: null },
      { apy_30d: 3, source_tvl_usd: null },
    ])).toBe(0);
  });

  it("returns 0 when all rows have zero TVL", () => {
    expect(computeTvlWeightedMedianApy([
      { apy_30d: 5, source_tvl_usd: 0 },
    ])).toBe(0);
  });

  it("returns the APY of a single valid row", () => {
    expect(computeTvlWeightedMedianApy([
      { apy_30d: 5, source_tvl_usd: 1_000_000 },
    ])).toBe(5);
  });

  it("returns TVL-weighted median, not simple median", () => {
    const result = computeTvlWeightedMedianApy([
      { apy_30d: 10, source_tvl_usd: 100_000 },
      { apy_30d: 3, source_tvl_usd: 10_000_000 },
    ]);
    expect(result).toBe(3);
  });

  it("filters out rows with zero or negative APY", () => {
    const result = computeTvlWeightedMedianApy([
      { apy_30d: 0, source_tvl_usd: 100_000_000 },
      { apy_30d: 5, source_tvl_usd: 1_000_000 },
    ]);
    expect(result).toBe(5);
  });

  it("picks median from sorted valid rows for balanced TVL", () => {
    const result = computeTvlWeightedMedianApy([
      { apy_30d: 2, source_tvl_usd: 1_000_000 },
      { apy_30d: 5, source_tvl_usd: 1_000_000 },
      { apy_30d: 8, source_tvl_usd: 1_000_000 },
    ]);
    expect(result).toBe(5);
  });
});

describe("findBestLendingPool with chain scope", () => {
  it("does not match a Solana pool for an Ethereum-only coin", () => {
    const pool = {
      pool: "p1", chain: "Solana", project: "kamino-lend", symbol: "USDC",
      tvlUsd: 200_000, apy: 5, apyBase: 5, apyReward: null,
      stablecoin: true, exposure: "single", underlyingTokens: null,
    };
    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST, {
      minApy: 0.1, minTvlUsd: 100_000, contractAddresses: [],
      chainFilter: new Set(["Ethereum"]),
    });
    expect(result).toBeNull();
  });

  it("matches a pool on the correct chain", () => {
    const pool = {
      pool: "p2", chain: "Ethereum", project: "aave-v3", symbol: "USDC",
      tvlUsd: 500_000, apy: 4, apyBase: 4, apyReward: null,
      stablecoin: true, exposure: "single", underlyingTokens: null,
    };
    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST, {
      minApy: 0.1, minTvlUsd: 100_000, contractAddresses: [],
      chainFilter: new Set(["Ethereum"]),
    });
    expect(result).toBeTruthy();
    expect(result?.chain).toBe("Ethereum");
  });

  it("matches any chain when chainFilter is omitted (backwards compat)", () => {
    const pool = {
      pool: "p3", chain: "Solana", project: "kamino-lend", symbol: "USDC",
      tvlUsd: 200_000, apy: 5, apyBase: 5, apyReward: null,
      stablecoin: true, exposure: "single", underlyingTokens: null,
    };
    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST, {
      minApy: 0.1, minTvlUsd: 100_000, contractAddresses: [],
    });
    expect(result).toBeTruthy();
  });
});

describe("parseWarningSignals", () => {
  it("returns empty array for empty string", () => {
    expect(parseWarningSignals("")).toEqual([]);
  });

  it("parses valid JSON array of strings", () => {
    expect(parseWarningSignals('["yield-spike","tvl-outflow"]')).toEqual(["yield-spike", "tvl-outflow"]);
  });

  it("filters out non-string elements", () => {
    expect(parseWarningSignals('[1, "yield-spike", null, true]')).toEqual(["yield-spike"]);
  });

  it("returns empty array and logs warning for malformed JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseWarningSignals("{not valid json")).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[yield-sync] failed to parse warning_signals"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array and logs warning for non-array JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseWarningSignals('{"key": "value"}')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[yield-sync] warning_signals is not an array"),
    );
    warnSpy.mockRestore();
  });
});
