import { describe, it, expect } from "vitest";
import { PSI_SWEEP_DURATION, psiSweepDuration } from "./psi-colors";

describe("PSI_SWEEP_DURATION", () => {
  it("has all six bands", () => {
    expect(Object.keys(PSI_SWEEP_DURATION).sort()).toEqual(
      ["BEDROCK", "CRISIS", "FRACTURE", "MELTDOWN", "STEADY", "TREMOR"],
    );
  });

  it("duration shrinks monotonically toward MELTDOWN", () => {
    const order = ["BEDROCK", "STEADY", "TREMOR", "FRACTURE", "CRISIS", "MELTDOWN"] as const;
    for (let i = 1; i < order.length; i++) {
      expect(PSI_SWEEP_DURATION[order[i]]).toBeLessThan(PSI_SWEEP_DURATION[order[i - 1]]);
    }
  });

  it("psiSweepDuration returns BEDROCK duration for unknown band", () => {
    expect(psiSweepDuration("BOGUS" as never)).toBe(PSI_SWEEP_DURATION.BEDROCK);
  });
});
