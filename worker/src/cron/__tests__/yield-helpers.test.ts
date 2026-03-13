import { describe, it, expect } from "vitest";
import {
  STALE_THRESHOLD_MS,
  computeApyFromRate,
  computeApyFromPrice,
  computePYS,
  computeYieldStability,
  computeApyVarianceScore,
  detectWarningSignals,
  matchAllDlPools,
  findBestLendingPool,
} from "../yield-helpers";

// computeTvlWeightedMedianApy is internal to sync-yield-data.ts - tested via integration
describe("STALE_THRESHOLD_MS", () => {
  it("equals 90 minutes in milliseconds", () => {
    expect(STALE_THRESHOLD_MS).toBe(5_400_000);
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

  it("returns higher score for higher safety score", () => {
    const risky = computePYS({ apy30d: 5, safetyScore: 30, apyVarianceScore: 0.1, scalingFactor: 10 });
    const safe = computePYS({ apy30d: 5, safetyScore: 90, apyVarianceScore: 0.1, scalingFactor: 10 });
    expect(safe).toBeGreaterThan(risky);
  });

  it("caps at 100", () => {
    const result = computePYS({ apy30d: 100, safetyScore: 100, apyVarianceScore: 0, scalingFactor: 100 });
    expect(result).toBeLessThanOrEqual(100);
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
});

describe("computeApyVarianceScore", () => {
  it("returns 0 for fewer than 2 samples", () => {
    expect(computeApyVarianceScore([])).toBe(0);
    expect(computeApyVarianceScore([5])).toBe(0);
  });

  it("returns 0 for constant samples", () => {
    expect(computeApyVarianceScore([5, 5, 5])).toBe(0);
  });

  it("returns higher score for more variance", () => {
    const low = computeApyVarianceScore([5, 5.1, 4.9]);
    const high = computeApyVarianceScore([1, 10, 1, 10]);
    expect(high).toBeGreaterThan(low);
  });

  it("caps at 1", () => {
    const result = computeApyVarianceScore([0.001, 100, 0.001, 100]);
    expect(result).toBeLessThanOrEqual(1);
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

  it("prefers exact symbol match over address fallback", () => {
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
    expect(result!.pool).toBe("p5");
  });

  it("applies optional min APY and TVL quality gates", () => {
    const result = findBestLendingPool("USDT", pools, allowlist, { minApy: 3.1, minTvlUsd: 15_000_000 });
    expect(result).toBeNull();
  });
});
