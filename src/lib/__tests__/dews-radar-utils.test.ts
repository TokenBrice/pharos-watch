// src/lib/__tests__/dews-radar-utils.test.ts
import { describe, it, expect } from "vitest";
import {
  scoreToRadius,
  deterministicOffset,
  deterministicRadiusOffset,
  distributeAngles,
  highestBand,
  sweepDuration,
  pulseDuration,
} from "@/lib/dews-radar-utils";

describe("scoreToRadius", () => {
  it("returns innerR when score is at band minimum", () => {
    expect(scoreToRadius(16, "WATCH")).toBeCloseTo(178);
  });
  it("returns outerR when score is at band maximum", () => {
    expect(scoreToRadius(35, "WATCH")).toBeCloseTo(208);
  });
  it("returns midpoint for mid-band score", () => {
    expect(scoreToRadius(25, "WATCH")).toBeGreaterThan(178);
    expect(scoreToRadius(25, "WATCH")).toBeLessThan(208);
  });
  it("returns innerR for ALERT minimum", () => {
    expect(scoreToRadius(36, "ALERT")).toBeCloseTo(143);
  });
  it("returns outerR for ALERT maximum", () => {
    expect(scoreToRadius(55, "ALERT")).toBeCloseTo(175);
  });
  it("returns innerR for WARNING minimum", () => {
    expect(scoreToRadius(56, "WARNING")).toBeCloseTo(95);
  });
  it("returns outerR for WARNING maximum", () => {
    expect(scoreToRadius(75, "WARNING")).toBeCloseTo(140);
  });
  it("returns innerR for DANGER minimum", () => {
    expect(scoreToRadius(76, "DANGER")).toBeCloseTo(45);
  });
  it("returns outerR for DANGER maximum", () => {
    expect(scoreToRadius(100, "DANGER")).toBeCloseTo(90);
  });
});

describe("deterministicOffset", () => {
  it("returns the same value for the same id on repeated calls", () => {
    expect(deterministicOffset("42")).toBe(deterministicOffset("42"));
  });
  it("returns different values for different ids", () => {
    // "1" has charSum=49, "999" has charSum=147 — different modular offsets
    expect(deterministicOffset("1")).not.toBe(deterministicOffset("999"));
  });
  it("returns a finite number in [0, π/6)", () => {
    const offset = deterministicOffset("123");
    expect(isFinite(offset)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(Math.PI / 6);
  });
  it("handles empty string without throwing", () => {
    expect(() => deterministicOffset("")).not.toThrow();
    expect(deterministicOffset("")).toBe(0);
  });
});

describe("deterministicRadiusOffset", () => {
  it("returns the same value for the same id and zoneWidth", () => {
    expect(deterministicRadiusOffset("42", 26)).toBe(deterministicRadiusOffset("42", 26));
  });
  it("returns a value in [0, zoneWidth)", () => {
    const result = deterministicRadiusOffset("123", 26);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(26);
  });
  it("returns 0 for empty string", () => {
    expect(deterministicRadiusOffset("", 26)).toBe(0);
  });
  it("uses the same charCode sum as deterministicOffset", () => {
    // "1" has charSum=49; 49 % 26 = 23
    expect(deterministicRadiusOffset("1", 26)).toBe(23);
  });
  it("respects the zoneWidth parameter", () => {
    // "1" charSum=49; 49 % 10 = 9
    expect(deterministicRadiusOffset("1", 10)).toBe(9);
  });
  it("returns 0 for zoneWidth of 0", () => {
    expect(deterministicRadiusOffset("abc", 0)).toBe(0);
  });
  it("returns 0 for negative zoneWidth", () => {
    expect(deterministicRadiusOffset("abc", -5)).toBe(0);
  });
});

describe("distributeAngles", () => {
  it("returns empty array for n=0", () => {
    expect(distributeAngles(0)).toEqual([]);
  });
  it("returns [-π/2] for n=1 (12 o'clock start)", () => {
    const angles = distributeAngles(1);
    expect(angles).toHaveLength(1);
    expect(angles[0]).toBeCloseTo(-Math.PI / 2);
  });
  it("returns 4 angles evenly spaced by π/2 for n=4", () => {
    const angles = distributeAngles(4);
    expect(angles).toHaveLength(4);
    const step = angles[1] - angles[0];
    expect(step).toBeCloseTo(Math.PI / 2);
    expect(angles[2] - angles[1]).toBeCloseTo(step);
    expect(angles[3] - angles[2]).toBeCloseTo(step);
  });
  it("covers a full 2π circle for any n>1", () => {
    const angles = distributeAngles(6);
    const totalSpan = angles[angles.length - 1] - angles[0] + (2 * Math.PI) / 6;
    expect(totalSpan).toBeCloseTo(2 * Math.PI);
  });
});

describe("highestBand", () => {
  it("returns CALM for empty array", () => {
    expect(highestBand([])).toBe("CALM");
  });
  it("returns CALM when only CALM bands present", () => {
    expect(highestBand(["CALM", "CALM"])).toBe("CALM");
  });
  it("returns the single elevated band when only one is present", () => {
    expect(highestBand(["CALM", "WATCH", "CALM"])).toBe("WATCH");
  });
  it("returns the highest when multiple bands are present", () => {
    expect(highestBand(["WATCH", "ALERT", "WARNING"])).toBe("WARNING");
  });
  it("returns DANGER when DANGER is present", () => {
    expect(highestBand(["WATCH", "DANGER", "ALERT"])).toBe("DANGER");
  });
});

describe("sweepDuration", () => {
  it("returns 12 for CALM", () => {
    expect(sweepDuration("CALM")).toBe(12);
  });
  it("returns a strictly decreasing duration as threat increases", () => {
    expect(sweepDuration("CALM")).toBeGreaterThan(sweepDuration("WATCH"));
    expect(sweepDuration("WATCH")).toBeGreaterThan(sweepDuration("ALERT"));
    expect(sweepDuration("ALERT")).toBeGreaterThan(sweepDuration("WARNING"));
    expect(sweepDuration("WARNING")).toBeGreaterThan(sweepDuration("DANGER"));
  });
});

describe("pulseDuration", () => {
  it("returns a strictly decreasing duration as threat increases", () => {
    expect(pulseDuration("WATCH")).toBeGreaterThan(pulseDuration("ALERT"));
    expect(pulseDuration("ALERT")).toBeGreaterThan(pulseDuration("WARNING"));
    expect(pulseDuration("WARNING")).toBeGreaterThan(pulseDuration("DANGER"));
  });
  it("returns a positive number for all bands", () => {
    expect(pulseDuration("WATCH")).toBeGreaterThan(0);
    expect(pulseDuration("ALERT")).toBeGreaterThan(0);
    expect(pulseDuration("WARNING")).toBeGreaterThan(0);
    expect(pulseDuration("DANGER")).toBeGreaterThan(0);
  });
});
