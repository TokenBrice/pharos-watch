import { describe, it, expect } from "vitest";
import { PSI_SWEEP_DURATION } from "../classification";

describe("PSI_SWEEP_DURATION", () => {
  it("has all six bands", () => {
    expect(Object.keys(PSI_SWEEP_DURATION).sort()).toEqual([
      "BEDROCK",
      "CRISIS",
      "FRACTURE",
      "MELTDOWN",
      "STEADY",
      "TREMOR",
    ]);
  });

});
