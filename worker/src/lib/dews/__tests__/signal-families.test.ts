import { describe, expect, it } from "vitest";
import {
  computeBlacklistSignal,
  computeDivergSignal,
  computeFlowSignal,
  computeLiquiditySignal,
  computePoolSignal,
  computePriceSignal,
  computeSupplySignal,
  computeYieldSignal,
} from "../signal-families";
import { makeDewsInput } from "../../__tests__/dews.test-support";

describe("DEWS signal family curves", () => {
  it("pins supply availability and blended contraction interpolation", () => {
    expect(computeSupplySignal(makeDewsInput({
      circulatingPrevDayAvailable: false,
      circulatingPrevWeekAvailable: false,
    }))).toEqual({
      value: 0,
      available: false,
      unavailableReason: "supply-history-anchors-missing",
    });

    const result = computeSupplySignal(makeDewsInput({
      // Keep the signal-family fixture's one-billion baseline explicit.
      mcapUsd: 1_000_000_000,
      circulatingCurrent: 98,
      circulatingPrevDay: 100,
      circulatingPrevWeek: 100,
    }));

    expect(result.available).toBe(true);
    expect(result.value).toBeCloseTo(20.5, 5);
    expect(result.delta1d).toBe(-2);
    expect(result.delta7d).toBe(-2);
    expect(result.sizeFactor).toBe(1);
  });

  it("pins pool blend, TVL floor, and smoothing behavior", () => {
    expect(computePoolSignal(makeDewsInput({ weightedBalanceRatio: null, avgPoolStress: 20 }))).toEqual({
      value: 0,
      available: false,
    });

    const result = computePoolSignal(makeDewsInput({
      weightedBalanceRatio: 0.8,
      avgPoolStress: 40,
      topPools: [
        { tvlUsd: 50_000, balanceRatio: 0.1 },
        { tvlUsd: 500_000, balanceRatio: 0.5 },
      ],
      prevPoolValue: 45,
    }));

    expect(result.available).toBe(true);
    expect(result.value).toBeCloseTo(39.75, 5);
    expect(result.worstPool).toBe(50);
  });

  it("pins liquidity score and TVL erosion curves", () => {
    expect(computeLiquiditySignal(makeDewsInput({
      liquidityScore: null,
      liquidityScore7dAgo: 100,
      tvlCurrent: 75,
      tvl7dAgo: 100,
    }))).toEqual({ value: 0, available: false });

    const result = computeLiquiditySignal(makeDewsInput({
      liquidityScore: 80,
      liquidityScore7dAgo: 100,
      tvlCurrent: 75,
      tvl7dAgo: 100,
    }));

    expect(result.available).toBe(true);
    expect(result.value).toBe(45);
    expect(result.scoreDelta7d).toBe(-20);
    expect(result.tvlDelta7d).toBe(-25);
  });

  it("pins price confidence scores and transition bonus exceptions", () => {
    expect(computePriceSignal(makeDewsInput({ price: null, priceConfidence: null }))).toEqual({
      value: 100,
      available: true,
      confidence: null,
    });
    expect(computePriceSignal(makeDewsInput({ priceConfidence: "low", prevPriceConfidence: "high" })).value).toBe(75);
    expect(computePriceSignal(makeDewsInput({ priceConfidence: "single-source", prevPriceConfidence: "high" })).value).toBe(25);
    expect(computePriceSignal(makeDewsInput({ priceConfidence: "fallback" })).value).toBe(80);
  });

  it("pins divergence curve anchors, non-USD damping, smoothing, and unavailable peg references", () => {
    expect(computeDivergSignal(makeDewsInput({
      pegReferenceAvailable: false,
      pegReferenceUnavailableReason: "thin-reference",
    }))).toEqual({
      value: 0,
      available: false,
      unavailableReason: "thin-reference",
    });

    const usd = computeDivergSignal(makeDewsInput({ price: 0.9925 }));
    expect(usd.available).toBe(true);
    expect(usd.value).toBeCloseTo(50, 5);
    expect(usd.primaryDevBps).toBe(75);

    const eur = computeDivergSignal(makeDewsInput({ pegType: "peggedEUR", price: 0.9925 }));
    expect(eur.value).toBeCloseTo(35, 5);

    const smoothed = computeDivergSignal(makeDewsInput({ price: 0.9925, prevDivergValue: 10 }));
    expect(smoothed.value).toBeCloseTo(30, 5);
  });

  it("fails closed on a non-positive price instead of publishing zero divergence", () => {
    // A zero/negative price is not "no divergence": the canonical derivation
    // returns null for it, and coercing that to 0 would report calm on a price
    // that cannot be a price.
    expect(computeDivergSignal(makeDewsInput({ price: 0 }))).toEqual({
      value: 0,
      available: false,
      unavailableReason: "invalid-price",
    });
    expect(computeDivergSignal(makeDewsInput({ price: -1 }))).toEqual({
      value: 0,
      available: false,
      unavailableReason: "invalid-price",
    });

    // A bad DEX price is dropped from the cross-source legs; the valid primary
    // deviation still reports rather than being diluted by a coerced zero.
    const badDex = computeDivergSignal(makeDewsInput({ price: 0.9925, dexPriceUsd: 0 }));
    expect(badDex.available).toBe(true);
    expect(badDex.primaryDevBps).toBe(75);
    expect(badDex.dexDevBps).toBe(0);
    expect(badDex.spreadBps).toBe(75);
  });

  it("pins blacklist count and spike multiplier curves", () => {
    expect(computeBlacklistSignal(makeDewsInput({ hasBlacklistTracking: false }))).toEqual({
      value: 0,
      available: false,
    });

    const result = computeBlacklistSignal(makeDewsInput({
      hasBlacklistTracking: true,
      blacklistEvents24h: 10,
      blacklistEvents7d: 14,
    }));

    expect(result.available).toBe(true);
    expect(result.value).toBe(66);
    expect(result.events24h).toBe(10);
    expect(result.events7d).toBe(14);
    expect(result.spikeRatio).toBe(5);
  });

  it("pins mint-burn flow fallbacks and burn pressure curves", () => {
    expect(computeFlowSignal(makeDewsInput({
      burnVolume24hUsd: 1_000_000,
      mintVolume24hUsd: 0,
      burnBaseline30dUsd: 100_000,
      flowBaselineDays: 3,
      flowDataAgeDays: 0.1,
    }))).toEqual({
      value: 0,
      available: false,
      baselineDays: 3,
      unavailableReason: "mint-burn-baseline-too-short",
    });
    expect(computeFlowSignal(makeDewsInput({
      burnVolume24hUsd: 1_000_000,
      mintVolume24hUsd: 0,
      burnBaseline30dUsd: 100_000,
      flowBaselineDays: 14,
      flowDataAgeDays: 3,
    }))).toEqual({
      value: 0,
      available: false,
      baselineDays: 14,
      unavailableReason: "mint-burn-stale",
    });

    const result = computeFlowSignal(makeDewsInput({
      burnVolume24hUsd: 2_000_000,
      mintVolume24hUsd: 0,
      burnBaseline30dUsd: 0,
      flowDataAgeDays: 0.1,
      flowBaselineDays: 14,
    }));

    expect(result.available).toBe(true);
    expect(result.burnSurge).toBe(5);
    expect(result.burnToMintRatio).toBe(10);
    expect(result.value).toBe(85);
    expect(result.net24hUsd).toBe(-2_000_000);
    expect(result.baselineDays).toBe(14);
  });

  it("pins legacy yield warning scores", () => {
    expect(computeYieldSignal(makeDewsInput())).toEqual({ value: 0, available: false });

    const result = computeYieldSignal(makeDewsInput({
      yieldWarnings: ["yield-spike", "yield-divergence", "tvl-outflow"],
    }));

    expect(result.available).toBe(true);
    expect(result.value).toBe(90);
    expect(result.warnings).toEqual(["yield-spike", "yield-divergence", "tvl-outflow"]);
  });

  it.each([
    ["structured-reward-heavy", { yieldSourceRisk: { rewardShare: 0.6 } }, 20],
    ["structured-thin-source-depth", { yieldSourceRisk: { sourceDepthRatio: 0.0005 } }, 35],
    ["structured-stale-source", { yieldSourceRisk: { sourceAgeSeconds: 7 * 60 * 60 } }, 15],
    ["structured-source-switch", { yieldSourceRisk: { sourceSwitchCount30d: 1 } }, 20],
    ["structured-source-risk-penalty", { yieldSourceRisk: { sourceRiskPenalty: 1.5 } }, 20],
    ["structured-medium-risk-venue", { yieldSourceRisk: { venueRiskTier: "medium" } }, 10],
    ["structured-high-risk-venue", { yieldSourceRisk: { venueRiskTier: "high" } }, 25],
    ["structured-rank-source-switch", { yieldRankChangeAttribution: { primaryDriver: "source-switch" } }, 20],
    ["structured-rank-source-risk", { yieldRankChangeAttribution: { primaryDriver: "source-risk" } }, 20],
  ] as const)("pins structured yield branch %s", (warning, override, value) => {
    const result = computeYieldSignal(makeDewsInput(override));

    expect(result.available).toBe(true);
    expect(result.value).toBe(value);
    expect(result.warnings).toContain(warning);
  });
});
