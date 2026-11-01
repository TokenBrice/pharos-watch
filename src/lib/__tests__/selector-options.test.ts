import { describe, expect, it } from "vitest";
import { DEPEG_OPTIONS } from "@/lib/selector-options";
import { activeDepegThresholdBps } from "@shared/lib/selector/exclusions";

describe("DEPEG_OPTIONS", () => {
  it("labels each tolerance with the admission ceiling the selector enforces", () => {
    for (const option of DEPEG_OPTIONS) {
      const percent = Number(option.label.split("Within ")[1]?.replace("%", ""));
      expect(Number.isFinite(percent), option.label).toBe(true);
      expect(Math.round(percent * 100)).toBe(activeDepegThresholdBps(option.value));
    }
  });
});
