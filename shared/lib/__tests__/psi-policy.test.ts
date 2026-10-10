import { describe, expect, it } from "vitest";
import { getConditionBand, PSI_COMPONENT_LIMITS, PSI_CONDITION_BANDS } from "../psi-policy";

describe("PSI policy", () => {
  it.each([
    [100, "BEDROCK"], [95, "BEDROCK"], [90, "BEDROCK"], [89.9, "STEADY"], [89, "STEADY"],
    [75, "STEADY"], [74.9, "TREMOR"], [60, "TREMOR"], [59.9, "FRACTURE"],
    [40, "FRACTURE"], [39.9, "CRISIS"], [20, "CRISIS"], [19.9, "MELTDOWN"],
    [10, "MELTDOWN"], [0, "MELTDOWN"], [-0.1, "MELTDOWN"], [NaN, "MELTDOWN"],
  ] as const)("maps score %s to %s at inclusive boundaries", (score, band) => {
    expect(getConditionBand(score)).toBe(band);
  });

  it("publishes the calibrated component limits and descending band boundaries", () => {
    expect(PSI_COMPONENT_LIMITS).toEqual({ severity: 68, breadth: 17, stressBreadth: 5, trend: 5 });
    expect(PSI_CONDITION_BANDS.map(({ min }) => min)).toEqual([90, 75, 60, 40, 20, 0]);
  });
});
