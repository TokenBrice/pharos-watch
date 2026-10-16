// src/lib/__tests__/dews-radar-utils.test.ts
import { describe, it, expect } from "vitest";
import {
  scoreToRadius,
  deterministicOffset,
  deterministicRadiusOffset,
  distributeAngles,
  highestBand,
} from "@/lib/dews-radar-utils";

describe("scoreToRadius", () => {
  it("returns innerR when score is at band minimum", () => {
    expect(scoreToRadius(16, "WATCH")).toBeCloseTo(178);
  });
  it("returns outerR when score is at band maximum", () => {
    expect(scoreToRadius(35, "WATCH")).toBeCloseTo(208);
  });
  it("interpolates linearly, placing the true midpoint score at the mid radius", () => {
    // WATCH spans scores 16..35 over radii 178..208, so 25.5 is the exact midpoint.
    expect(scoreToRadius(25.5, "WATCH")).toBeCloseTo(193);
    const lowerStep = scoreToRadius(25, "WATCH") - scoreToRadius(20, "WATCH");
    const upperStep = scoreToRadius(30, "WATCH") - scoreToRadius(25, "WATCH");
    expect(lowerStep).toBeGreaterThan(0);
    expect(lowerStep).toBeCloseTo(upperStep);
  });
  it("clamps scores outside the band to the band's radial zone", () => {
    expect(scoreToRadius(10, "WATCH")).toBeCloseTo(178);
    expect(scoreToRadius(90, "WATCH")).toBeCloseTo(208);
  });
});

describe("deterministicOffset", () => {
  it("returns a finite number in [0, π/6)", () => {
    const offset = deterministicOffset("123");
    expect(isFinite(offset)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(Math.PI / 6);
  });
});

describe("deterministicRadiusOffset", () => {
  it("keeps representative ids deterministic and inside every zone width", () => {
    const ids = ["1", "999", "usdc-circle", "dai-maker"];
    for (const width of [10, 26, 45]) {
      const offsets = ids.map((id) => deterministicRadiusOffset(id, width));
      for (const offset of offsets) {
        expect(Number.isInteger(offset)).toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(width);
      }
      // Distinct ids must not collapse onto one radius inside the zone.
      expect(new Set(offsets).size).toBe(ids.length);
      expect(offsets).toEqual(ids.map((id) => deterministicRadiusOffset(id, width)));
    }
  });
});

describe("distributeAngles", () => {
  it("returns 4 angles evenly spaced by π/2 for n=4", () => {
    const angles = distributeAngles(4);
    expect(angles).toHaveLength(4);
    const step = angles[1] - angles[0];
    expect(step).toBeCloseTo(Math.PI / 2);
    expect(angles[2] - angles[1]).toBeCloseTo(step);
    expect(angles[3] - angles[2]).toBeCloseTo(step);
  });
});

describe("highestBand", () => {
  it("returns CALM for empty array", () => {
    expect(highestBand([])).toBe("CALM");
  });
  it("returns the highest when multiple bands are present", () => {
    expect(highestBand(["WATCH", "ALERT", "WARNING"])).toBe("WARNING");
  });
  it("returns DANGER when DANGER is present", () => {
    expect(highestBand(["WATCH", "DANGER", "ALERT"])).toBe("DANGER");
  });
});

