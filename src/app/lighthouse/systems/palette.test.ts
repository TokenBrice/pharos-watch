import { describe, it, expect } from "vitest";
import { HARBOR_PALETTE, hexToInt, paletteOrThrow, paletteRgba } from "./palette";

describe("HARBOR_PALETTE", () => {
  it("contains 25 entries", () => {
    expect(Object.keys(HARBOR_PALETTE)).toHaveLength(25);
  });

  it("each value is a 7-char hex starting with #", () => {
    for (const [k, v] of Object.entries(HARBOR_PALETTE)) {
      expect(v, k).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("hexToInt parses #d49a3e to 0xd49a3e", () => {
    expect(hexToInt("#d49a3e")).toBe(0xd49a3e);
  });

  it("paletteOrThrow returns the named color", () => {
    expect(paletteOrThrow("lantern_warm")).toBe("#d49a3e");
  });

  it("paletteOrThrow throws on unknown key", () => {
    expect(() => paletteOrThrow("not_a_color" as never)).toThrow(/HARBOR_PALETTE/);
  });

  it("paletteRgba builds an rgba string for a palette entry", () => {
    expect(paletteRgba("lantern_warm", 0.5)).toBe("rgba(212, 154, 62, 0.5)");
    expect(paletteRgba("deep_sea_2", 0)).toBe("rgba(10, 14, 29, 0)");
    expect(paletteRgba("foam_white", 1)).toBe("rgba(232, 238, 240, 1)");
  });
});
