import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DEX_GLOBAL_KEY, type DexLiquidityData, type DexLiquidityMap } from "@shared/types/market";
import { buildLiquidityViewModel, formatLiquidityWarningMessage } from "./model";

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
  it("shares HTTP warning decoding without changing liquidity-specific quality copy", () => {
    expect(formatLiquidityWarningMessage('199 - "Latest sync-dex-liquidity run shows high quality drift (assets=a,b)"'))
      .toBe("Some liquidity data is being re-verified");
    const warning = '199 - "Provider delayed,\nread retained", 110 - "Response is stale"';
    expect(formatLiquidityWarningMessage(warning)).toBe("Provider delayed,\nread retained Response is stale");
    expect(formatLiquidityWarningMessage(warning)).not.toContain("199 -");
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
    expect(model.leaderboardRows.map((row) => row.meta.id)).toEqual([usdScored.id]);
    expect(model.unobservedRows).toEqual([]);
    expect(model.summaryStats).toMatchObject({
      totalTvl: 999,
      totalTvlUnavailableReason: null,
      totalVol: 111,
      ratedCount: 2,
      nrObservedCount: 0,
      withLiquidity: 2,
      highConfidenceCoverage: 1,
      fallbackCoverage: 1,
      agg7dChange: 0,
      avgBalance: 88,
      avgOrganic: 60,
    });
  });

  it("keeps observed NR rows in the leaderboard and folds unobserved coins", () => {
    const [first, second, third] = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === "USD");
    if (!first || !second || !third) {
      throw new Error("Expected at least three USD stablecoins in active registry");
    }

    const model = buildLiquidityViewModel(
      {
        [first.id]: makeLiquidity({ liquidityScore: 70 }),
        [second.id]: makeLiquidity({ liquidityScore: null, liquidityScoreUnavailableReason: "activity-missing" }),
        [third.id]: makeLiquidity({
          liquidityScore: null, totalTvlUsd: 0, poolCount: 0, coverageClass: "unobserved",
          liquidityEvidenceClass: "unobserved", liquidityScoreUnavailableReason: "no-retained-pools",
        }),
      },
      "all",
      "",
    );

    expect(model.rows.map((row) => row.meta.id)).toEqual([first.id, second.id, third.id]);
    expect(model.leaderboardRows.map((row) => row.meta.id)).toEqual([first.id, second.id]);
    expect(model.unobservedRows.map((row) => row.meta.id)).toEqual([third.id]);
    expect(model.summaryStats).toMatchObject({ ratedCount: 1, nrObservedCount: 1, withLiquidity: 2 });
  });

  it("counts observed primary mixed and fallback NR markets independently of rated scores", () => {
    const [rated, primary, mixed, fallback, placeholder, unknown] = ACTIVE_STABLECOINS;
    const model = buildLiquidityViewModel({
      [rated.id]: makeLiquidity({ liquidityScore: 80 }),
      [primary.id]: makeLiquidity({ liquidityScore: null, coverageClass: "primary" }),
      [mixed.id]: makeLiquidity({
        liquidityScore: null, coverageClass: "mixed", liquidityEvidenceClass: "partial_measured",
      }),
      [fallback.id]: makeLiquidity({
        liquidityScore: null, coverageClass: "fallback", liquidityEvidenceClass: "observed_unmeasured",
        hasMeasuredLiquidityEvidence: false, trendworthy: false,
      }),
      [placeholder.id]: makeLiquidity({
        liquidityScore: null, totalTvlUsd: 0, poolCount: 0, coverageClass: "unobserved",
        liquidityEvidenceClass: "unobserved", hasMeasuredLiquidityEvidence: false, trendworthy: false,
      }),
      [unknown.id]: makeLiquidity({
        liquidityScore: null, coverageClass: null, liquidityEvidenceClass: null,
      }),
    }, "all", "");

    expect(model.summaryStats).toMatchObject({
      withLiquidity: 4, highConfidenceCoverage: 3, fallbackCoverage: 1, ratedCount: 1, nrObservedCount: 3,
    });
  });

  it("preserves missing global TVL and an all-NR cohort as unavailable aggregates", () => {
    const model = buildLiquidityViewModel({
      [ACTIVE_STABLECOINS[0].id]: makeLiquidity({ liquidityScore: null }),
    }, "all", "");

    expect(model.summaryStats).toMatchObject({
      totalTvl: null, totalTvlUnavailableReason: "global-row-missing", ratedCount: 0, withLiquidity: 1,
    });
  });

  it("preserves a measured global zero TVL and a rated zero score as numeric aggregates", () => {
    const model = buildLiquidityViewModel({
      [DEX_GLOBAL_KEY]: makeLiquidity({ totalTvlUsd: 0 }),
      [ACTIVE_STABLECOINS[0].id]: makeLiquidity({ liquidityScore: 0 }),
    }, "all", "");

    expect(model.summaryStats).toMatchObject({ totalTvl: 0, ratedCount: 1 });
  });

  it("withholds a quarantined global row's depth and names its reason", () => {
    const model = buildLiquidityViewModel({
      [DEX_GLOBAL_KEY]: makeLiquidity({ totalTvlUsd: 999, unavailableReason: "invalid-coverage-evidence" }),
    }, "all", "");

    expect(model.summaryStats).toMatchObject({
      totalTvl: null, totalTvlUnavailableReason: "invalid-coverage-evidence", totalVol: null,
    });
    expect(model.summaryStats).not.toHaveProperty("totalVolAvailability");
  });
});
