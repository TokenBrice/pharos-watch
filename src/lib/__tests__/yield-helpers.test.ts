import { describe, it, expect } from "vitest";
import {
  computePYS,
  computeApyFromRate,
  computeApyFromPrice,
  computeYieldStability,
  computeApyVarianceScore,
  detectWarningSignals,
  findBestLendingPool,
} from "../../../worker/src/cron/yield-helpers";

describe("computeApyFromRate", () => {
  it("returns correct APY for 7-day rate change", () => {
    const apy = computeApyFromRate(1.001, 1.0, 7);
    // (1.001)^(365.25/7) - 1 ≈ 5.35%
    expect(apy).toBeCloseTo(5.4, 0);
  });
  it("returns 0 when rates are equal", () => {
    expect(computeApyFromRate(1.0, 1.0, 7)).toBe(0);
  });
  it("returns negative for decreasing rate", () => {
    expect(computeApyFromRate(0.999, 1.0, 7)).toBeLessThan(0);
  });
  it("returns 0 when previous rate is 0", () => {
    expect(computeApyFromRate(1.0, 0, 7)).toBe(0);
  });
});

describe("computeApyFromPrice", () => {
  it("computes annualized return from 30-day price change", () => {
    const apy = computeApyFromPrice(1.01, 1.0, 30);
    expect(apy).toBeCloseTo(12.8, 0);
  });
  it("returns 0 when prices are equal", () => {
    expect(computeApyFromPrice(1.0, 1.0, 30)).toBe(0);
  });
  it("returns 0 when old price is 0", () => {
    expect(computeApyFromPrice(1.01, 0, 30)).toBe(0);
  });
});

describe("computePYS", () => {
  it("scores safe high-yield coin well", () => {
    const pys = computePYS({ apy30d: 8, safetyScore: 82, apyVarianceScore: 0.05, scalingFactor: 5 });
    expect(pys).toBeCloseTo(40, 0);
  });
  it("penalizes low safety score", () => {
    const safe = computePYS({ apy30d: 10, safetyScore: 90, apyVarianceScore: 0, scalingFactor: 5 });
    const risky = computePYS({ apy30d: 10, safetyScore: 40, apyVarianceScore: 0, scalingFactor: 5 });
    expect(safe).toBeGreaterThan(risky);
  });
  it("penalizes high variance", () => {
    const stable = computePYS({ apy30d: 10, safetyScore: 70, apyVarianceScore: 0.1, scalingFactor: 5 });
    const volatile = computePYS({ apy30d: 10, safetyScore: 70, apyVarianceScore: 0.8, scalingFactor: 5 });
    expect(stable).toBeGreaterThan(volatile);
  });
  it("caps at 100", () => {
    const pys = computePYS({ apy30d: 100, safetyScore: 95, apyVarianceScore: 0, scalingFactor: 10 });
    expect(pys).toBe(100);
  });
  it("returns 0 for 0% APY", () => {
    expect(computePYS({ apy30d: 0, safetyScore: 90, apyVarianceScore: 0, scalingFactor: 5 })).toBe(0);
  });
});

describe("computeYieldStability", () => {
  it("returns 1 for perfectly stable yields", () => {
    expect(computeYieldStability([5, 5, 5, 5, 5])).toBe(1);
  });
  it("returns lower values for volatile yields", () => {
    const stability = computeYieldStability([5, 15, 5, 15, 5]);
    expect(stability).toBeLessThan(0.5);
  });
  it("returns null for empty array", () => {
    expect(computeYieldStability([])).toBeNull();
  });
  it("returns null for single value", () => {
    expect(computeYieldStability([5])).toBeNull();
  });
  it("returns 1 for near-zero values (no Infinity from floating-point)", () => {
    expect(computeYieldStability([1e-15, 2e-15])).toBe(1);
  });
});

describe("computeApyVarianceScore", () => {
  it("returns 0 for near-zero values (no Infinity from floating-point)", () => {
    expect(computeApyVarianceScore([1e-15, 2e-15])).toBe(0);
  });
});

describe("detectWarningSignals", () => {
  it("detects yield spike", () => {
    const signals = detectWarningSignals({ currentApy: 25, apy30d: 10, apyReward: null, medianApy: 8, sourceTvlUsd: null, prevTvlUsd: null });
    expect(signals).toContain("yield-spike");
  });
  it("detects reward-heavy yield", () => {
    const signals = detectWarningSignals({ currentApy: 20, apy30d: 18, apyReward: 17, medianApy: 8, sourceTvlUsd: null, prevTvlUsd: null });
    expect(signals).toContain("reward-heavy");
  });
  it("returns empty for healthy yield", () => {
    const signals = detectWarningSignals({ currentApy: 5, apy30d: 5, apyReward: null, medianApy: 6, sourceTvlUsd: 1e9, prevTvlUsd: 1e9 });
    expect(signals).toHaveLength(0);
  });
});

describe("findBestLendingPool", () => {
  const allowlist = new Set(["aave-v3", "compound-v3", "maple"]);

  const makeDlPool = (overrides: Partial<{
    pool: string; symbol: string; project: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string; chain: string;
    underlyingTokens: string[] | null;
  }>) => ({
    pool: "pool-1",
    symbol: "USDC",
    project: "aave-v3",
    tvlUsd: 1_000_000,
    apy: 3.5,
    apyBase: 3.5,
    apyReward: null,
    stablecoin: true,
    exposure: "single",
    chain: "Ethereum",
    apyMean30d: 3.5,
    underlyingTokens: null,
    ...overrides,
  });

  it("returns the highest-TVL pool from an allowlisted protocol", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", tvlUsd: 500_000 }),
      makeDlPool({ pool: "b", project: "aave-v3", tvlUsd: 2_000_000 }),
      makeDlPool({ pool: "c", project: "compound-v3", tvlUsd: 1_000_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("b"); // highest TVL
  });

  it("excludes pools from non-allowlisted protocols", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "sketchy-dex", tvlUsd: 10_000_000 }),
      makeDlPool({ pool: "b", project: "aave-v3", tvlUsd: 500_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result!.pool).toBe("b");
  });

  it("excludes multi-exposure pools", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", exposure: "multi", tvlUsd: 5_000_000 }),
      makeDlPool({ pool: "b", project: "aave-v3", exposure: "single", tvlUsd: 100_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result!.pool).toBe("b");
  });

  it("excludes non-stablecoin pools", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", stablecoin: false, tvlUsd: 5_000_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result).toBeNull();
  });

  it("matches symbol case-insensitively", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", symbol: "usdc" }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result).not.toBeNull();
  });

  it("falls back to underlying token address when symbol does not match", () => {
    const pools = [
      makeDlPool({
        pool: "a",
        symbol: "FEUSDH",
        project: "compound-v3",
        tvlUsd: 3_000_000,
        underlyingTokens: ["0x111111a1a0667d36bd57c0a9f569b98057111111"],
      }),
    ];
    const result = findBestLendingPool("USDH", pools, allowlist, {
      contractAddresses: ["0x111111A1A0667d36Bd57c0A9f569b98057111111"],
    });
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("a");
  });

  it("prefers exact symbol match over address fallback", () => {
    const pools = [
      makeDlPool({
        pool: "a",
        symbol: "USDH",
        project: "aave-v3",
        tvlUsd: 1_000_000,
        underlyingTokens: ["0xabc"],
      }),
      makeDlPool({
        pool: "b",
        symbol: "FEUSDH",
        project: "compound-v3",
        tvlUsd: 9_000_000,
        underlyingTokens: ["0xabc"],
      }),
    ];
    const result = findBestLendingPool("USDH", pools, allowlist, {
      contractAddresses: ["0xAbC"],
    });
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("a");
  });

  it("returns null when no pools match", () => {
    const result = findBestLendingPool("XSGD", [], allowlist);
    expect(result).toBeNull();
  });

  it("applies optional min APY and TVL quality gates", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", apy: 0.4, tvlUsd: 10_000_000 }),
      makeDlPool({ pool: "b", project: "aave-v3", apy: 3.0, tvlUsd: 500_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist, { minApy: 0.5, minTvlUsd: 1_000_000 });
    expect(result).toBeNull();
  });
});
