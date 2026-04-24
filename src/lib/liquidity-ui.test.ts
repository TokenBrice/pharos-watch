import { describe, it, expect } from "vitest";
import {
  COVERAGE_FILL_CLASSES,
  COVERAGE_TEXT_CLASSES,
  rippleIntensityBand,
  clarityOpacity,
  depthFillPct,
} from "./liquidity-ui";

describe("COVERAGE_FILL_CLASSES", () => {
  it("has an entry for every coverage class", () => {
    for (const key of ["primary", "mixed", "fallback", "legacy", "unobserved"] as const) {
      expect(COVERAGE_FILL_CLASSES[key]).toBeTruthy();
      expect(COVERAGE_TEXT_CLASSES[key]).toBeTruthy();
    }
  });
});

describe("rippleIntensityBand", () => {
  it("returns 'still' below 100k volume", () => {
    expect(rippleIntensityBand(0)).toBe("still");
    expect(rippleIntensityBand(99_999)).toBe("still");
  });
  it("returns 'gentle' between 100k and 10M", () => {
    expect(rippleIntensityBand(100_000)).toBe("gentle");
    expect(rippleIntensityBand(5_000_000)).toBe("gentle");
  });
  it("returns 'choppy' at and above 10M", () => {
    expect(rippleIntensityBand(10_000_000)).toBe("choppy");
    expect(rippleIntensityBand(500_000_000)).toBe("choppy");
  });
});

describe("clarityOpacity", () => {
  it("returns 0 when organicFraction is 1 (perfectly clear)", () => {
    expect(clarityOpacity(1)).toBe(0);
  });
  it("returns high opacity when organicFraction is 0 (fully murky)", () => {
    expect(clarityOpacity(0)).toBeGreaterThan(0.5);
  });
  it("clamps null to default mid-murk", () => {
    const v = clarityOpacity(null);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
  it("is monotonic decreasing in organic fraction", () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map(clarityOpacity);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]!);
    }
  });
});

describe("depthFillPct", () => {
  it("returns 0 for null score", () => {
    expect(depthFillPct(null)).toBe(0);
  });
  it("clamps scores to [0, 100]", () => {
    expect(depthFillPct(-5)).toBe(0);
    expect(depthFillPct(120)).toBe(100);
  });
  it("passes through valid scores", () => {
    expect(depthFillPct(42)).toBe(42);
    expect(depthFillPct(0)).toBe(0);
    expect(depthFillPct(100)).toBe(100);
  });
});
