import { describe, expect, it } from "vitest";
import {
  LOWEST_SUB_DIMENSION_CANDIDATES,
  lookupNormalizedSubDimension,
  selectLowestSubDimension,
} from "../lowest-sub-dimension";
import type { MergedRow } from "../types";
import { makeMergedRowWithIdentity } from "./fixture";

function makeRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return makeMergedRowWithIdentity({ id: "t", symbol: "T", name: "T" }, {
    effectiveTvlUsd: 1e8,
    ...overrides,
  });
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
      for (const retired of ["dependencyRisk", "collateralQuality", "custodyModel"]) {
        expect(candidates).not.toContain(retired);
      }
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
