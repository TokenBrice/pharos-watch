// src/lib/__tests__/dews-radar-utils.test.ts
import { describe, it, expect } from "vitest";
import {
  deterministicRadiusOffset,
  distributeAngles,
  highestBand,
} from "@/lib/dews-radar-utils";

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

