import { describe, it, expect } from "vitest";
import { classifyPoolType, normalizeProtocol, initMetrics, computeLiquidityScore, computeDurabilityScore } from "../pool-helpers";

describe("normalizeProtocol", () => {
  it("collapses hyphenated PancakeSwap variants", () => {
    expect(normalizeProtocol("pancake-swap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancakeswap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancake_swap_v3")).toBe("pancakeswap");
  });
  it("collapses hyphenated Uniswap variants", () => {
    expect(normalizeProtocol("uni-v3")).toBe("uniswap-v3");
    expect(normalizeProtocol("uniswap-v3")).toBe("uniswap-v3");
  });
});

describe("classifyPoolType ordering", () => {
  it("classifies aerodrome-slipstream before the generic aerodrome branch", () => {
    expect(classifyPoolType("aerodrome-slipstream")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("aerodrome-slipstream-base")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("velodrome-slipstream")).toBe("velodrome-slipstream-5bp");
    expect(classifyPoolType("aerodrome")).toBe("aerodrome-volatile");
  });
});

describe("computeLiquidityScore", () => {
  it("happy path: score is in [0, 100] with reasonable inputs", () => {
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 5_000_000;
    m.totalTvlUsd = 10_000_000;
    m.totalVolume24hUsd = 100_000;
    m.qualityAdjustedTvl = 7_000_000;
    m.poolCount = 10;
    const { score } = computeLiquidityScore(m, 60, 100_000_000);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("depthRatio ≈ 0.5% → tvlDepth ≈ 30", () => {
    // depthRatio = 5_000_000 / 1_000_000_000 = 0.005
    // tvlDepth = 35 * log10(0.005 / 0.0007) = 35 * log10(7.143) ≈ 35 * 0.854 ≈ 29.9 → 30
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 5_000_000;
    m.totalTvlUsd = 5_000_000;
    m.qualityAdjustedTvl = 5_000_000;
    m.poolCount = 1;
    const { components } = computeLiquidityScore(m, 0, 1_000_000_000);
    expect(components.tvlDepth).toBeCloseTo(30, 0);
  });

  it("fallback TVL Depth at $5M tracks the ratio formula at 0.5% of $1B", () => {
    // v5.5 calibration: absolute fallback (no circulatingUsd) shares the
    // ratio formula's anchor via a $1B implied reference mcap.
    // At $5M TVL both branches should yield ~30.
    const metricsBase = () => {
      const m = initMetrics("test", "TEST");
      m.effectiveTvl = 5_000_000;
      m.totalTvlUsd = 5_000_000;
      m.qualityAdjustedTvl = 5_000_000;
      m.poolCount = 1;
      return m;
    };
    const ratioBranch = computeLiquidityScore(metricsBase(), 50, 1_000_000_000);
    const fallbackBranch = computeLiquidityScore(metricsBase(), 50, undefined);
    expect(
      Math.abs(ratioBranch.components.tvlDepth - fallbackBranch.components.tvlDepth),
    ).toBeLessThan(2);
  });

  it("zero volume → volumeActivity = 0", () => {
    // vtRatio = 0 / totalTvlUsd → volumeActivity = 0
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 1_000_000;
    m.totalTvlUsd = 1_000_000;
    m.totalVolume24hUsd = 0;
    m.qualityAdjustedTvl = 1_000_000;
    m.poolCount = 5;
    const { components } = computeLiquidityScore(m, 50, 10_000_000);
    expect(components.volumeActivity).toBe(0);
  });

  it("qualityAdjustedTvl = 0.5 * totalTvlUsd → poolQuality ≈ 54", () => {
    // qualityRetention = 0.5
    // poolQuality = (0.5 - 0.15) / 0.65 * 100 = 0.35 / 0.65 * 100 ≈ 53.8 → 54
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 10_000_000;
    m.totalTvlUsd = 10_000_000;
    m.qualityAdjustedTvl = 5_000_000;
    m.poolCount = 5;
    const { components } = computeLiquidityScore(m, 50, 100_000_000);
    expect(components.poolQuality).toBeCloseTo(54, 0);
  });

  it("poolCount = 20 → pairDiversity = 100 (capped)", () => {
    // pairDiversity = min(100, 20 * 5) = 100
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 1_000_000;
    m.totalTvlUsd = 1_000_000;
    m.qualityAdjustedTvl = 1_000_000;
    m.poolCount = 20;
    const { components } = computeLiquidityScore(m, 50, 10_000_000);
    expect(components.pairDiversity).toBe(100);
  });

  it("NaN guard: all-zero metrics produce a finite score", () => {
    // tvlInput = 0 → falls back to totalTvlUsd = 0, uses absolute fallback (tvlDepth=0)
    // vtRatio = 0/0 → volumeActivity = 0; qualityRetention = 0/0 → poolQuality = 0
    const m = initMetrics("test", "TEST");
    const { score } = computeLiquidityScore(m, 0);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("extreme inputs → score capped at 100", () => {
    // Very high TVL, volume, quality, many pools → raw > 100, must clamp to 100
    const m = initMetrics("test", "TEST");
    m.effectiveTvl = 1_000_000_000;
    m.totalTvlUsd = 1_000_000_000;
    m.totalVolume24hUsd = 1_000_000_000;
    m.qualityAdjustedTvl = 1_000_000_000;
    m.poolCount = 1000;
    const { score } = computeLiquidityScore(m, 100, 1_000_000);
    expect(score).toBe(100);
  });

  it("zero inputs (no circulatingUsd) → score 0", () => {
    // effectiveTvl=0 → uses absolute fallback: 35*log10(1/700_000) → very negative → clamped to 0
    // all other components also 0 → total = 0
    const m = initMetrics("test", "TEST");
    const { score } = computeLiquidityScore(m, 0);
    expect(score).toBe(0);
  });
});

describe("computeDurabilityScore", () => {
  it("organicFraction = 0.25 → organic sub-score ≈ 50", () => {
    // sqrt(0.25) * 100 = 50; organic weight = 0.15
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 250_000;
    m.totalTvlForOrganic = 1_000_000;
    // With neutral stabilities (null → 50 each) and no maturity (0):
    // raw = 50*0.15 + 50*0.35 + 50*0.25 + 0*0.25 = 7.5+17.5+12.5+0 = 37.5 → 38
    const score = computeDurabilityScore(m, null, null);
    expect(score).toBe(38);
  });

  it("organicFraction = 1.0 → organic sub-score = 100", () => {
    // sqrt(1.0) * 100 = 100
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 1_000_000;
    m.totalTvlForOrganic = 1_000_000;
    // raw = 100*0.15 + 50*0.35 + 50*0.25 + 0*0.25 = 15+17.5+12.5+0 = 45 → 45
    const score = computeDurabilityScore(m, null, null);
    expect(score).toBe(45);
  });

  it("null stabilities → neutral 50 fallback for each", () => {
    // tvlStabilityScore = 50, volumeConsistencyScore = 50
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 0;
    m.totalTvlForOrganic = 0; // organicFraction fallback = 0.5 → sqrt(0.5)*100 ≈ 70.7
    // raw = 70.7*0.15 + 50*0.35 + 50*0.25 + 0*0.25 = 10.6+17.5+12.5+0 = 40.6 → 41
    const score = computeDurabilityScore(m, null, null);
    expect(score).toBe(41);
  });

  it("tvlStability = 1.0 → tvlStabilityScore = 100", () => {
    // tvlStabilityScore = 100; all others neutral/zero
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 0;
    m.totalTvlForOrganic = 0; // organicFraction fallback = 0.5 → sqrt(0.5)*100 ≈ 70.7
    // raw = 70.7*0.15 + 100*0.35 + 50*0.25 + 0*0.25 = 10.6+35+12.5+0 = 58.1 → 58
    const score = computeDurabilityScore(m, 1.0, null);
    expect(score).toBe(58);
  });

  it("oldestPoolDays = 365 → maturityScore = 100", () => {
    // maturityScore = min(100, (365/365)*100) = 100
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 0;
    m.totalTvlForOrganic = 0; // organicFraction fallback = 0.5 → sqrt(0.5)*100 ≈ 70.7
    m.oldestPoolDays = 365;
    // raw = 70.7*0.15 + 50*0.35 + 50*0.25 + 100*0.25 = 10.6+17.5+12.5+25 = 65.6 → 66
    const score = computeDurabilityScore(m, null, null);
    expect(score).toBe(66);
  });

  it("oldestPoolDays = 0 → maturityScore = 0", () => {
    // maturityScore = min(100, (0/365)*100) = 0
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 0;
    m.totalTvlForOrganic = 0; // organicFraction fallback = 0.5
    m.oldestPoolDays = 0;
    // raw = 70.7*0.15 + 50*0.35 + 50*0.25 + 0*0.25 = 10.6+17.5+12.5+0 = 40.6 → 41
    const score = computeDurabilityScore(m, null, null);
    expect(score).toBe(41);
  });

  it("full weighted combination: verifies the math end-to-end", () => {
    // organicFraction = 0.25 → sqrt(0.25)*100 = 50, *0.15 = 7.5
    // tvlStability = 0.8 → 80, *0.35 = 28
    // volumeStability = 0.6 → 60, *0.25 = 15
    // oldestPoolDays = 180 → (180/365)*100 ≈ 49.3, *0.25 ≈ 12.3
    // raw ≈ 7.5+28+15+12.3 = 62.8 → round → 63
    const m = initMetrics("test", "TEST");
    m.organicTvlWeightedSum = 250_000;
    m.totalTvlForOrganic = 1_000_000;
    m.oldestPoolDays = 180;
    const score = computeDurabilityScore(m, 0.8, 0.6);
    expect(score).toBe(63);
  });
});
