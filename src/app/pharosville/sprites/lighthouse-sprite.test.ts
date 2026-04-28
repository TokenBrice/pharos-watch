import { describe, it, expect } from "vitest";
import { LIGHTHOUSE_GEOM } from "./lighthouse-sprite";

describe("lighthouse geometry", () => {
  it("totals 192px tall waterline-to-cap", () => {
    const g = LIGHTHOUSE_GEOM;
    const total = g.base.h + g.shaft.h + g.gallery.h + g.lantern.h + g.cap.h;
    expect(total).toBe(192);
  });

  it("base is wider than lantern", () => {
    expect(LIGHTHOUSE_GEOM.base.w).toBeGreaterThan(LIGHTHOUSE_GEOM.lantern.w);
  });
});
