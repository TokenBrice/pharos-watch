import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DEX_GLOBAL_KEY, type DexLiquidityData, type DexLiquidityMap } from "@shared/types/market";
import {
  buildLiquidityViewModel,
  formatLiquidityWarningMessage,
  normalizePegFilter,
} from "./model";

function makeLiquidity(overrides: Partial<DexLiquidityData> = {}): DexLiquidityData {
  return {
    totalTvlUsd: 100,
    totalVolume24hUsd: 10,
    totalVolume7dUsd: 70,
    poolCount: 1,
    pairCount: 1,
    chainCount: 1,
    protocolTvl: {},
    chainTvl: {},
    topPools: [],
    liquidityScore: 50,
    concentrationHhi: null,
    depthStability: null,
    tvlChange24h: null,
    tvlChange7d: null,
    updatedAt: 1,
    dexPriceUsd: null,
    dexDeviationBps: null,
    priceSourceCount: null,
    priceSourceTvl: null,
    priceSources: null,
    effectiveTvlUsd: 100,
    avgPoolStress: null,
    weightedBalanceRatio: null,
    organicFraction: null,
    durabilityScore: null,
    coverageClass: "primary",
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    trendworthy: true,
    sourceMix: {},
    balanceMeasuredTvlUsd: 0,
    organicMeasuredTvlUsd: 0,
    scoreComponents: null,
    lockedLiquidityPct: null,
    methodologyVersion: "test",
    ...overrides,
  };
}

describe("liquidity page model", () => {
  it("normalizes unsupported peg filters to all", () => {
    expect(normalizePegFilter("EUR")).toBe("EUR");
    expect(normalizePegFilter("not-a-peg")).toBe("all");
  });

  it("formats batch warning payloads into readable messages", () => {
    expect(formatLiquidityWarningMessage('123 - "Curve degraded", 456 - "Uniswap degraded"')).toBe(
      "Curve degraded Uniswap degraded",
    );
  });

  it("keeps visible rows filtered while computing summary stats from the full liquidity map", () => {
    const [usdScored, usdUnrated] = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === "USD");
    const eurScored = ACTIVE_STABLECOINS.find((coin) => coin.flags.pegCurrency === "EUR");
    if (!usdScored || !usdUnrated || !eurScored) {
      throw new Error("Expected USD and EUR stablecoins in active registry");
    }

    const liquidityMap: DexLiquidityMap = {
      [DEX_GLOBAL_KEY]: makeLiquidity({
        totalTvlUsd: 999,
        totalVolume24hUsd: 111,
      }),
      [usdScored.id]: makeLiquidity({
        liquidityScore: 80,
        coverageClass: "primary",
        totalTvlUsd: 110,
        tvlChange7d: 10,
        weightedBalanceRatio: 0.5,
        balanceMeasuredTvlUsd: 100,
        organicFraction: 0.8,
        organicMeasuredTvlUsd: 100,
      }),
      [eurScored.id]: makeLiquidity({
        liquidityScore: 20,
        coverageClass: "fallback",
        totalTvlUsd: 90,
        tvlChange7d: -10,
        weightedBalanceRatio: 1,
        balanceMeasuredTvlUsd: 300,
        organicFraction: 0.4,
        organicMeasuredTvlUsd: 100,
      }),
      [usdUnrated.id]: makeLiquidity({
        liquidityScore: null,
        coverageClass: "unobserved",
      }),
    };

    const model = buildLiquidityViewModel(liquidityMap, "USD", usdScored.name.toLowerCase());

    expect(model.rows.map((row) => row.meta.id)).toEqual([usdScored.id]);
    expect(model.scoredRows.map((row) => row.meta.id)).toEqual([usdScored.id]);
    expect(model.unratedRows).toEqual([]);
    expect(model.summaryStats).toMatchObject({
      totalTvl: 999,
      totalVol: 111,
      avgScore: 50,
      withLiquidity: 2,
      highConfidenceCoverage: 1,
      fallbackCoverage: 1,
      agg7dChange: 0,
      avgBalance: 88,
      avgOrganic: 60,
    });
  });

  it("splits unfiltered rows into scored and unrated groups", () => {
    const [first, second] = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === "USD");
    if (!first || !second) {
      throw new Error("Expected at least two USD stablecoins in active registry");
    }

    const model = buildLiquidityViewModel(
      {
        [first.id]: makeLiquidity({ liquidityScore: 70 }),
        [second.id]: makeLiquidity({ liquidityScore: null }),
      },
      "all",
      "",
    );

    expect(model.rows.map((row) => row.meta.id)).toEqual([first.id, second.id]);
    expect(model.scoredRows.map((row) => row.meta.id)).toEqual([first.id]);
    expect(model.unratedRows.map((row) => row.meta.id)).toEqual([second.id]);
  });
});
