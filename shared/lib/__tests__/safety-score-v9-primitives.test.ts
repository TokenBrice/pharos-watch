import { describe, expect, it } from "vitest";
import { clampScore } from "@shared/lib/safety-score-v9/primitives";

describe("Safety Score V9 clampScore", () => {
  it("hardens non-finite scores through the V9 import path", () => {
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(Infinity)).toBe(100);
  });
});
