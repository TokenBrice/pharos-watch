import { describe, expect, it } from "vitest";
import { MAX_MAIN_CANVAS_PIXELS, resolveCanvasBudget } from "./canvas-budget";

describe("canvas budget", () => {
  it("caps effective DPR by main canvas backing pixels", () => {
    const budget = resolveCanvasBudget({
      cssWidth: 2560,
      cssHeight: 1440,
      requestedDpr: 3,
    });

    expect(budget.effectiveDpr).toBeLessThan(2);
    expect(budget.backingPixels).toBeLessThanOrEqual(MAX_MAIN_CANVAS_PIXELS);
  });

  it("keeps normal desktop DPR at the requested value when under budget", () => {
    const budget = resolveCanvasBudget({
      cssWidth: 1440,
      cssHeight: 1000,
      requestedDpr: 1,
    });

    expect(budget.effectiveDpr).toBe(1);
  });
});
