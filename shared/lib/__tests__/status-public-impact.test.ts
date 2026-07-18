import { describe, expect, it } from "vitest";
import type { StatusCause } from "../../types/status";
import { transitionHasPublicImpact } from "../status-public-impact";

function cause(overrides: Partial<StatusCause> = {}): StatusCause {
  return {
    code: "active_price_coverage_incomplete",
    layer: "data-quality",
    severity: "warning",
    message: "Live prices are unavailable for active assets.",
    ...overrides,
  };
}

describe("transitionHasPublicImpact", () => {
  it("keeps low-ratio incomplete active-price coverage advisory", () => {
    expect(transitionHasPublicImpact([cause()])).toBe(false);
  });

  it("treats unknown exact active-price coverage as public impact", () => {
    expect(transitionHasPublicImpact([cause({ code: "active_price_coverage_unknown" })])).toBe(true);
  });

  it("does not promote informational active-price coverage causes", () => {
    expect(transitionHasPublicImpact([cause({ severity: "info" })])).toBe(false);
  });

  it("treats degraded or stale missing-price ratios as public impact", () => {
    expect(transitionHasPublicImpact([cause({ code: "missing_prices_degraded" })])).toBe(true);
    expect(transitionHasPublicImpact([cause({ code: "missing_prices_stale", severity: "critical" })])).toBe(true);
  });
});
