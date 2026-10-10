import { describe, expect, it } from "vitest";
import { derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";
import { getCalibrationConcentrationReason } from "../maintenance/yield-venue-risk-calibration";

describe("yield calibration concentration attribution", () => {
  it("does not name low concentration for a venue-driven mover", () => {
    const input = { venueRiskWeighted: 4, dependencyConcentrationSeverity: "low" as const };
    const oldPenalty = derivePysSourceRiskPenalty({ venueRiskWeighted: 2 });
    expect(derivePysSourceRiskPenalty(input) - oldPenalty).toBeGreaterThan(0.01);
    expect(getCalibrationConcentrationReason(input, { ecosystem: "sky" })).toBeNull();
  });

  it.each(["medium", "high"] as const)("names effective %s concentration", (severity) => {
    expect(getCalibrationConcentrationReason({
      venueRiskWeighted: 4, dependencyConcentrationSeverity: severity,
    }, { ecosystem: "sky" })).toBe("concentration:sky");
  });

  it("does not name concentration when the canonical penalty cap erases its contribution", () => {
    expect(getCalibrationConcentrationReason({
      venueRiskWeighted: 5, rewardShare: 1, sourceDepthRatio: 0,
      sourceAgeSeconds: 86400, sourceSwitchCount30d: 3, observationCount30d: 1,
      dependencyConcentrationSeverity: "high",
    }, { ecosystem: "sky" })).toBeNull();
  });
});
