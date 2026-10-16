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
  it("no candidate set offers a retired axis", () => {
    for (const candidates of Object.values(LOWEST_SUB_DIMENSION_CANDIDATES)) {
      for (const retired of ["dependencyRisk", "collateralQuality", "custodyModel"]) {
        expect(candidates).not.toContain(retired);
      }
    }
  });
});

describe("lookupNormalizedSubDimension", () => {
  it("retired axes never resolve to a value", () => {
    expect(lookupNormalizedSubDimension(makeRow({ custodyModel: "cex" }), "custodyModel")).toBeNull();
    expect(lookupNormalizedSubDimension(makeRow(), "collateralQuality")).toBeNull();
    expect(lookupNormalizedSubDimension(makeRow(), "dependencyRisk")).toBeNull();
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
});
