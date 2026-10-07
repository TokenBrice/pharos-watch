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
  it.each(["heavy_scheduled_delivery_stalled", "heavy_scheduler_liveness_unavailable"])(
    "retains %s in public incident history at warning/critical severity", (code) => {
      expect(transitionHasPublicImpact([cause({ code, layer: "availability", severity: "warning" })])).toBe(true);
      expect(transitionHasPublicImpact([cause({ code, layer: "availability", severity: "critical" })])).toBe(true);
      expect(transitionHasPublicImpact([cause({ code, layer: "availability", severity: "info" })])).toBe(false);
    },
  );
  it("keeps incomplete active-price coverage warning-only", () => {
    expect(transitionHasPublicImpact([cause()])).toBe(false);
  });

  it.each([
    ["price_gap_reviews_expiring", "info"],
    ["price_gap_reviews_expiring", "warning"],
    ["reserve_feed_reviews_expiring", "info"],
    ["reserve_feed_reviews_expiring", "warning"],
  ] as const)("keeps %s at %s severity admin-only", (code, severity) => {
    expect(transitionHasPublicImpact([cause({ code, severity })])).toBe(false);
  });

  it("treats a duration-degraded persistent price gap as public impact", () => {
    expect(transitionHasPublicImpact([cause({ code: "active_price_coverage_duration_degraded" })])).toBe(true);
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
