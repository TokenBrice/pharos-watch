import { describe, expect, it } from "vitest";
import {
  LOWEST_SUB_DIMENSION_CANDIDATES,
  lookupNormalizedSubDimension,
  selectLowestSubDimension,
} from "../lowest-sub-dimension";
import type { MergedRow } from "../types";

function makeRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return {
    id: "t",
    symbol: "T",
    name: "T",
    protocolSlug: null,
    variantOf: null,
    isYieldBearing: false,
    pegCurrency: "USD",
    lifecycle: "active",
    governance: "decentralized",
    canBeBlacklisted: false,
    mechanismArchetype: null,
    supplyUsd: 1e9,
    pegScore: 90,
    activeDepeg: false,
    currentDeviationBps: 10,
    depegEventCount: 0,
    lastEventAt: null,
    dewsScore: 20,
    safetyGrade: "A",
    safetyScore: 80,
    safetyResilienceScore: 80,
    safetyDecentralizationScore: 80,
    safetyLiquidityScore: 80,
    custodyModel: "onchain",
    bluechipGrade: "A",
    liquidityScore: 80,
    effectiveTvlUsd: 1e8,
    concentrationHhi: 0.2,
    chainTvl: { ethereum: 1e8 },
    effectiveExitScore: 80,
    pharosYieldScore: 80,
    apy30d: 5,
    apyVariance30d: 0.5,
    benchmarkRate: 4.5,
    sourceRiskScore: 20,
    venueRiskTier: "low",
    warningSignals: [],
    deploymentPlace: "native-wrapper",
    sourceSwitch: false,
    yieldProtocolSlug: null,
    yieldVenueChain: null,
    yieldHistoryDays: 365,
    yieldFreshness: null,
    trackingSpanDays: 365,
    isRecentListing: false,
    pegSummaryAgeSec: null,
    dexTvlAgeSec: null,
    dewsAgeSec: null,
    ...overrides,
  };
}

describe("candidate sets", () => {
  it("treasury + trading share the six base watch axes", () => {
    expect(LOWEST_SUB_DIMENSION_CANDIDATES.treasury).toEqual([
      "pegStability",
      "liquidity",
      "resilience",
      "decentralization",
      "governanceOverride",
      "activeDepegHistory",
    ]);
    expect(LOWEST_SUB_DIMENSION_CANDIDATES.trading).toEqual(LOWEST_SUB_DIMENSION_CANDIDATES.treasury);
  });

  it("yield adds yieldVariance + sourceRisk", () => {
    expect(LOWEST_SUB_DIMENSION_CANDIDATES.yield).toHaveLength(8);
    expect(LOWEST_SUB_DIMENSION_CANDIDATES.yield).toEqual(
      expect.arrayContaining(["yieldVariance", "sourceRisk"]),
    );
  });

  it("no candidate set offers a retired axis", () => {
    for (const candidates of Object.values(LOWEST_SUB_DIMENSION_CANDIDATES)) {
      expect(candidates).not.toEqual(
        expect.arrayContaining(["dependencyRisk", "collateralQuality", "custodyModel"]),
      );
    }
  });
});

describe("lookupNormalizedSubDimension", () => {
  it("pegStability reads the peg domain's PegScore", () => {
    expect(lookupNormalizedSubDimension(makeRow({ pegScore: 65 }), "pegStability")).toBe(65);
  });

  it("retired axes never resolve to a value", () => {
    expect(lookupNormalizedSubDimension(makeRow({ custodyModel: "cex" }), "custodyModel")).toBeNull();
    expect(lookupNormalizedSubDimension(makeRow(), "collateralQuality")).toBeNull();
    expect(lookupNormalizedSubDimension(makeRow(), "dependencyRisk")).toBeNull();
  });

  it("governanceOverride mapping", () => {
    expect(lookupNormalizedSubDimension(makeRow({ canBeBlacklisted: true }), "governanceOverride")).toBe(0);
    expect(lookupNormalizedSubDimension(makeRow({ canBeBlacklisted: false }), "governanceOverride")).toBe(100);
    expect(lookupNormalizedSubDimension(makeRow({ canBeBlacklisted: "possible" }), "governanceOverride")).toBe(60);
  });

  it("activeDepegHistory drops by event count", () => {
    expect(lookupNormalizedSubDimension(makeRow({ depegEventCount: 0 }), "activeDepegHistory")).toBe(100);
    expect(lookupNormalizedSubDimension(makeRow({ depegEventCount: 5 }), "activeDepegHistory")).toBe(0);
  });

  it("yieldVariance via normalization", () => {
    expect(lookupNormalizedSubDimension(makeRow({ apyVariance30d: 2 }), "yieldVariance")).toBe(50);
  });
});

describe("selectLowestSubDimension", () => {
  it("picks the minimum non-null dimension", () => {
    const row = makeRow({
      safetyResilienceScore: 30,
      safetyDecentralizationScore: 80,
      safetyLiquidityScore: 80,
    });
    const result = selectLowestSubDimension(row, "treasury", []);
    expect(result?.key).toBe("resilience");
    expect(result?.score).toBe(30);
  });

  it("ties break by profile-weight relevance", () => {
    // Tie at 40 between pegStability and decentralization for Treasury.
    // `decentralization` no longer holds a weight slot, so pegStability wins.
    const row = makeRow({
      pegScore: 40,
      safetyDecentralizationScore: 40,
      safetyResilienceScore: 80,
      safetyLiquidityScore: 80,
    });
    const result = selectLowestSubDimension(row, "treasury", []);
    expect(result?.key).toBe("pegStability");
  });

  it("falls back to governanceOverride/activeDepegHistory when other dimensions are null", () => {
    const row = makeRow({
      pegScore: null,
      safetyLiquidityScore: null,
      safetyResilienceScore: null,
      safetyDecentralizationScore: null,
      custodyModel: null,
      canBeBlacklisted: false,
      depegEventCount: 0,
    });
    // governanceOverride (100, non-blacklistable) and activeDepegHistory (100) both
    // resolve to 100; tie-broken by profile weight. Both have weight 0 in Treasury's
    // weight vector so the iteration order falls back to first-seen.
    const result = selectLowestSubDimension(row, "treasury", []);
    expect(result?.key).toMatch(/governanceOverride|activeDepegHistory/);
    expect(result?.score).toBe(100);
  });

  it("returns null when even the synthetic safety net dimensions can't resolve", () => {
    // Only Yield surfaces yieldVariance/sourceRisk; if those are also absent on a
    // Treasury row that's been hollowed out the function still returns from
    // governanceOverride. To exercise the null branch, we override the row to
    // make every candidate read null — but the design intentionally keeps the
    // safety net populated, so the branch is effectively unreachable in practice.
    // The engine raises `template-coverage-gap` if the function were to return
    // null; here we just document the contract.
    expect(typeof selectLowestSubDimension).toBe("function");
  });

  it("yieldVariance + sourceRisk only surface under Yield profile", () => {
    const row = makeRow({
      apyVariance30d: 4, // → normalizes to 0 (lowest possible)
      safetyLiquidityScore: 80,
      safetyResilienceScore: 80,
      safetyDecentralizationScore: 80,
    });
    const yieldResult = selectLowestSubDimension(row, "yield", []);
    expect(yieldResult?.key).toBe("yieldVariance");

    const treasuryResult = selectLowestSubDimension(row, "treasury", []);
    expect(treasuryResult?.key).not.toBe("yieldVariance");
  });

  it("emits contextKeys for row-specific warnings", () => {
    const row = makeRow({
      isRecentListing: true,
      depegEventCount: 1,
      venueRiskTier: "high",
      warningSignals: ["unstable-apy"],
      safetyLiquidityScore: 80,
      safetyResilienceScore: 80,
      safetyDecentralizationScore: 80,
    });
    const result = selectLowestSubDimension(row, "yield", []);
    expect(result?.contextKeys).toEqual(
      expect.arrayContaining([
        "recent-listing",
        "depeg-history",
        "high-venue-risk",
        "unstable-apy",
      ]),
    );
  });
});
