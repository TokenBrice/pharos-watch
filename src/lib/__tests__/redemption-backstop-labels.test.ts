import { describe, expect, it } from "vitest";
import {
  formatRedemptionDocsProvenance,
  formatRedemptionModelConfidence,
  formatRedemptionResolutionState,
  formatRedemptionRouteFamily,
  formatRedemptionRouteStatus,
  REDEMPTION_ROUTE_FAMILY_DISPLAY,
} from "../redemption-backstop-labels";

describe("redemption-backstop-labels", () => {
  it("keeps route family labels and coverage labels in one map", () => {
    expect(formatRedemptionRouteFamily("offchain-issuer")).toBe("Offchain issuer");
    expect(formatRedemptionRouteFamily("psm-swap")).toBe("PSM / swap floor");
    expect(REDEMPTION_ROUTE_FAMILY_DISPLAY["collateral-redeem"]).toMatchObject({
      coverageLabel: "Collat.",
      coverageBreakdownLabel: "collateral",
      coverageSpokenLabel: "Collateral redeem",
    });
  });

  it("formats route status, resolution, confidence, and docs provenance labels", () => {
    expect(formatRedemptionRouteStatus("cohort-limited")).toBe("cohort limited");
    expect(formatRedemptionRouteStatus("unknown")).toBe("status unknown");
    expect(formatRedemptionResolutionState("missing-capacity")).toBe("missing capacity");
    expect(formatRedemptionModelConfidence("medium")).toBe("Confidence: medium");
    expect(formatRedemptionDocsProvenance("proof-of-reserves")).toBe("Fallback proof-of-reserves source");
  });
});
