import { describe, expect, it } from "vitest";
import type { StatusCause } from "../../types/status";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";

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
  it("keeps incomplete active-price coverage warning-only", () => {
    expect(transitionHasPublicImpact([cause()])).toBe(false);
  });

  it("treats unknown exact active-price coverage as public impact", () => {
    expect(transitionHasPublicImpact([cause({ code: "active_price_coverage_unknown" })])).toBe(true);
  });

  it("does not promote informational active-price coverage causes", () => {
    expect(transitionHasPublicImpact([cause({ code: "active_price_coverage_unknown", severity: "info" })])).toBe(false);
  });

  it("promotes critical public causes even alongside admin-only causes", () => {
    const publicCause = cause({ code: "active_price_coverage_unknown", severity: "critical" });
    expect(transitionHasPublicImpact([publicCause])).toBe(true);
    expect(transitionHasPublicImpact([cause(), publicCause])).toBe(true);
    expect(transitionHasPublicImpact([publicCause, cause()])).toBe(true);
  });

  it("keeps aggregate missing-price drift admin-only", () => {
    expect(transitionHasPublicImpact([cause({ code: "missing_prices_degraded" })])).toBe(false);
  });
});
