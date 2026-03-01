import { describe, it, expect } from "vitest";
import { computeDEWS, piecewiseLinear, getThreatBand } from "../dews";
import type { DEWSInput } from "../dews";

// --- piecewiseLinear tests ---

describe("piecewiseLinear", () => {
  const anchors: [number, number][] = [
    [0, 0],
    [1, 15],
    [3, 40],
    [5, 65],
    [10, 85],
    [20, 100],
  ];

  it("returns 0 at lower bound", () => {
    expect(piecewiseLinear(0, anchors)).toBe(0);
  });

  it("returns exact anchor value", () => {
    expect(piecewiseLinear(3, anchors)).toBe(40);
  });

  it("interpolates between anchors", () => {
    // Between [1, 15] and [3, 40]: at 2, expect 15 + (40-15) * (2-1)/(3-1) = 27.5
    expect(piecewiseLinear(2, anchors)).toBeCloseTo(27.5, 1);
  });

  it("clamps at maximum anchor", () => {
    expect(piecewiseLinear(30, anchors)).toBe(100);
  });

  it("clamps at 0 for negative input", () => {
    expect(piecewiseLinear(-5, anchors)).toBe(0);
  });
});

// --- getThreatBand tests ---

describe("getThreatBand", () => {
  it.each([
    [0, "CALM"],
    [15, "CALM"],
    [16, "WATCH"],
    [35, "WATCH"],
    [36, "ALERT"],
    [55, "ALERT"],
    [56, "WARNING"],
    [75, "WARNING"],
    [76, "DANGER"],
    [100, "DANGER"],
  ] as const)("score %d => %s", (score, band) => {
    expect(getThreatBand(score)).toBe(band);
  });
});

// --- computeDEWS tests ---

function baseInput(overrides: Partial<DEWSInput> = {}): DEWSInput {
  return {
    stablecoinId: "1",
    mcapUsd: 5e9,
    pegType: "peggedUSD",
    // Supply velocity
    circulatingCurrent: 5e9,
    circulatingPrevDay: 5e9,
    circulatingPrevWeek: 5e9,
    // Pool balance
    weightedBalanceRatio: null,
    avgPoolStress: null,
    topPools: null,
    // Liquidity erosion
    liquidityScore: null,
    liquidityScore7dAgo: null,
    tvlCurrent: null,
    tvl7dAgo: null,
    // Price confidence
    priceConfidence: "high",
    prevPriceConfidence: null,
    price: 1.0,
    // Cross-source divergence
    pegRef: 1.0,
    dexPriceUsd: null,
    // Blacklist activity
    blacklistEvents24h: 0,
    blacklistEvents7d: 0,
    hasBlacklistTracking: false,
    // Mint/burn flow
    burnVolume24hUsd: null,
    mintVolume24hUsd: null,
    burnBaseline30dUsd: null,
    mintBaseline30dUsd: null,
    flowDataAgeDays: 0,
    ...overrides,
  };
}

describe("computeDEWS", () => {
  it("returns CALM for a healthy large-cap coin with all signals available", () => {
    const result = computeDEWS(
      baseInput({
        weightedBalanceRatio: 0.97,
        avgPoolStress: 0.02,
        topPools: [],
        liquidityScore: 80,
        liquidityScore7dAgo: 78,
        tvlCurrent: 1e8,
        tvl7dAgo: 9.5e7,
      }),
    );
    expect(result.band).toBe("CALM");
    expect(result.score).toBeLessThanOrEqual(15);
    expect(result.signals.supply.available).toBe(true);
    expect(result.signals.pool.available).toBe(true);
  });

  it("produces a non-zero score when supply and price are available", () => {
    // Supply always available (from cache), price always available
    const result = computeDEWS(baseInput({ price: null, priceConfidence: null }));
    // S_price = 100 for null price, S_supply = 0 (no change)
    // 2 signals available => score should be >0
    expect(result.score).toBeGreaterThan(0);
  });

  it("detects supply velocity stress", () => {
    const result = computeDEWS(
      baseInput({
        circulatingCurrent: 4.5e9, // -10% from prev day
        circulatingPrevDay: 5e9,
        circulatingPrevWeek: 5.5e9, // -18% from prev week
      }),
    );
    expect(result.signals.supply.value).toBeGreaterThan(50);
    expect(result.band).not.toBe("CALM");
  });

  it("dampens supply velocity for small coins", () => {
    const large = computeDEWS(
      baseInput({
        mcapUsd: 5e9,
        circulatingCurrent: 4.75e9,
        circulatingPrevDay: 5e9,
      }),
    );
    const small = computeDEWS(
      baseInput({
        mcapUsd: 10e6,
        circulatingCurrent: 9.5e6,
        circulatingPrevDay: 10e6,
      }),
    );
    expect(large.signals.supply.value).toBeGreaterThan(small.signals.supply.value);
  });

  it("detects pool balance drift", () => {
    const result = computeDEWS(
      baseInput({
        weightedBalanceRatio: 0.45,
        avgPoolStress: 0.7,
        topPools: [{ tvlUsd: 5e6, balanceRatio: 0.3 }],
      }),
    );
    expect(result.signals.pool.available).toBe(true);
    expect(result.signals.pool.value).toBeGreaterThan(50);
  });

  it("detects price confidence degradation", () => {
    const result = computeDEWS(
      baseInput({
        priceConfidence: "low",
        prevPriceConfidence: "high",
      }),
    );
    // 60 base + 15 transition bonus = 75
    expect(result.signals.price.value).toBe(75);
  });

  it("detects cross-source price divergence", () => {
    const result = computeDEWS(
      baseInput({
        price: 0.995, // 50bps off peg
        dexPriceUsd: 0.99, // 100bps off peg
      }),
    );
    expect(result.signals.diverg.available).toBe(true);
    expect(result.signals.diverg.value).toBeGreaterThan(25);
  });

  it("dampens S_diverg for non-USD pegs", () => {
    const usd = computeDEWS(
      baseInput({
        pegType: "peggedUSD",
        price: 0.995,
        dexPriceUsd: 0.99,
      }),
    );
    const eur = computeDEWS(
      baseInput({
        pegType: "peggedEUR",
        price: 0.995,
        dexPriceUsd: 0.99,
      }),
    );
    expect(usd.signals.diverg.value).toBeGreaterThan(eur.signals.diverg.value);
  });

  it("detects blacklist activity spike", () => {
    const result = computeDEWS(
      baseInput({
        hasBlacklistTracking: true,
        blacklistEvents24h: 15,
        blacklistEvents7d: 20,
      }),
    );
    expect(result.signals.black.available).toBe(true);
    expect(result.signals.black.value).toBeGreaterThan(40);
  });

  it("marks blacklist unavailable for untracked coins", () => {
    const result = computeDEWS(baseInput({ hasBlacklistTracking: false }));
    expect(result.signals.black.available).toBe(false);
  });

  it("integrates mint/burn flow signal when available", () => {
    const result = computeDEWS(
      baseInput({
        burnVolume24hUsd: 5e8,
        mintVolume24hUsd: 1e7,
        burnBaseline30dUsd: 1e8,
        mintBaseline30dUsd: 1e8,
        flowDataAgeDays: 14,
      }),
    );
    expect(result.signals.flow.available).toBe(true);
    expect(result.signals.flow.value).toBeGreaterThan(40);
  });

  it("marks flow unavailable when no mint/burn data", () => {
    const result = computeDEWS(baseInput());
    expect(result.signals.flow.available).toBe(false);
  });

  it("marks flow unavailable when data too young (<7 days)", () => {
    const result = computeDEWS(
      baseInput({
        burnVolume24hUsd: 5e8,
        mintVolume24hUsd: 1e7,
        burnBaseline30dUsd: 1e8,
        mintBaseline30dUsd: 1e8,
        flowDataAgeDays: 3,
      }),
    );
    expect(result.signals.flow.available).toBe(false);
  });
});
