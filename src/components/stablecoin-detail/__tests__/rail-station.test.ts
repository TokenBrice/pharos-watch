import { describe, expect, it } from "vitest";
import { REDEMPTION_SETTLEMENT_LABELS } from "@shared/lib/redemption-backstop-scoring";
import { isMonoArrowLabel } from "../rail-station";

describe("isMonoArrowLabel", () => {
  it("keeps the mono figure treatment for pure figures only", () => {
    expect(isMonoArrowLabel("1-7")).toBe(true);
    expect(isMonoArrowLabel("≤ 24")).toBe(true);
  });

  it("reads every label containing a letter as prose, whatever it leads with", () => {
    for (const label of Object.values(REDEMPTION_SETTLEMENT_LABELS)) {
      expect(isMonoArrowLabel(label)).toBe(false);
    }
    expect(isMonoArrowLabel("T+1")).toBe(false);
    expect(isMonoArrowLabel("Next business day")).toBe(false);
  });
});
