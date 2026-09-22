import { describe, expect, it } from "vitest";
import { DexExitRouteObservationsSchema, MAX_DEX_EXIT_ROUTE_OBSERVATIONS } from "../../types/market";
import { FixedDexLiquidityRowSchema } from "../report-cards-fixed-input-identity";

function placeholderObservations(count: number) {
  return Array.from({ length: count }, (_, index) => ({ routeId: `ethereum:0x0:${index}` }));
}

function hasArrayLevelIssue(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) {
  return !result.success && result.error!.issues.some((issue) => issue.path.length === 0);
}

describe("DEX exit-route observation bound", () => {
  it("carries MAX_DEX_EXIT_ROUTE_OBSERVATIONS in the schema itself", () => {
    expect(MAX_DEX_EXIT_ROUTE_OBSERVATIONS).toBe(24);
    expect(DexExitRouteObservationsSchema.safeParse(placeholderObservations(24)).success).toBe(false);
    expect(DexExitRouteObservationsSchema.safeParse([]).success).toBe(true);
  });

  it("rejects a 25-observation payload on the array bound, not only per element", () => {
    // Element payloads are intentionally incomplete so per-element issues
    // fire in both cases; only the 25-row parse carries an array-level issue.
    expect(hasArrayLevelIssue(DexExitRouteObservationsSchema.safeParse(placeholderObservations(24)))).toBe(false);
    expect(hasArrayLevelIssue(DexExitRouteObservationsSchema.safeParse(placeholderObservations(25)))).toBe(true);
  });

  it("fails the fixed-input identity parse of a 25-observation row like the public route", () => {
    const row = (observations: unknown[]) => ({
      liquidityScore: null,
      updatedAt: 0,
      exitRouteObservations: observations,
    });
    const at24 = FixedDexLiquidityRowSchema.safeParse(row(placeholderObservations(24)));
    const at25 = FixedDexLiquidityRowSchema.safeParse(row(placeholderObservations(25)));
    expect(at24.success).toBe(false);
    expect(
      at24.error!.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "exitRouteObservations"),
    ).toBe(false);
    expect(at25.success).toBe(false);
    expect(
      at25.error!.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "exitRouteObservations"),
    ).toBe(true);
  });
});
