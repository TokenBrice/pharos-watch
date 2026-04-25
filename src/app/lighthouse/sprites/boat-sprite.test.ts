import { describe, it, expect } from "vitest";
import { BOAT_DIMENSIONS, BOAT_SCALE } from "./boat-sprite";

describe("boat dimensions", () => {
  it("has S and L for every style", () => {
    for (const style of ["galleon", "brigantine", "schooner", "junk"] as const) {
      expect(BOAT_DIMENSIONS[style].S.w).toBeGreaterThan(0);
      expect(BOAT_DIMENSIONS[style].L.w).toBeGreaterThan(BOAT_DIMENSIONS[style].S.w);
    }
  });

  it("hulls are taller than they are short", () => {
    for (const style of ["galleon", "brigantine", "schooner", "junk"] as const) {
      expect(BOAT_DIMENSIONS[style].L.h).toBeGreaterThan(BOAT_DIMENSIONS[style].L.w * 0.6);
    }
  });

  it("exports BOAT_SCALE = 2 for integer-pixel scaling", () => {
    expect(BOAT_SCALE).toBe(2);
  });
});
