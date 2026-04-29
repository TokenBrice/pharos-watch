import { describe, it, expect } from "vitest";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import { DEWS_AREA_LABEL_COLORS, HARBOR_PALETTE, WATER_TERRAIN_STYLES, hexToInt, paletteOrThrow, paletteRgba, waterTerrainStyle } from "./palette";

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

  it("defines explicit styles for every rendered water terrain", () => {
    expect(Object.keys(WATER_TERRAIN_STYLES).sort()).toEqual([
      "alert-water",
      "calm-water",
      "deep-water",
      "harbor-water",
      "ledger-water",
      "storm-water",
      "warning-water",
      "watch-water",
      "water",
    ]);
    expect(waterTerrainStyle("calm-water")?.texture).toBe("calm");
    expect(waterTerrainStyle("ledger-water")?.texture).toBe("ledger");
    expect(waterTerrainStyle("watch-water")?.texture).toBe("watch");
    expect(waterTerrainStyle("unknown")).toBeNull();
  });

  it("keeps water terrain zones visually separable by color and texture", () => {
    const styles = Object.values(WATER_TERRAIN_STYLES);

    expect(new Set(styles.map((style) => style.texture)).size).toBe(styles.length);
    expect(minimumHexDistance(styles.map((style) => style.base))).toBeGreaterThan(18);
    expect(WATER_TERRAIN_STYLES["calm-water"].texture).not.toBe(WATER_TERRAIN_STYLES["watch-water"].texture);
    expect(hexDistance(WATER_TERRAIN_STYLES["calm-water"].base, WATER_TERRAIN_STYLES["harbor-water"].base)).toBeGreaterThan(32);
    expect(hexDistance(WATER_TERRAIN_STYLES["calm-water"].base, WATER_TERRAIN_STYLES["alert-water"].base)).toBeGreaterThan(32);
    expect(WATER_TERRAIN_STYLES["warning-water"].accent).not.toBe(WATER_TERRAIN_STYLES.water.accent);
    expect(WATER_TERRAIN_STYLES["ledger-water"].base).not.toBe(WATER_TERRAIN_STYLES["calm-water"].base);
  });

  it("uses canonical DEWS threat colors for water-area labels", () => {
    expect(DEWS_AREA_LABEL_COLORS).toEqual({
      CALM: THREAT_BAND_HEX.CALM,
      WATCH: THREAT_BAND_HEX.WATCH,
      ALERT: THREAT_BAND_HEX.ALERT,
      WARNING: THREAT_BAND_HEX.WARNING,
      DANGER: THREAT_BAND_HEX.DANGER,
    });
  });
});

function minimumHexDistance(colors: string[]) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let first = 0; first < colors.length; first += 1) {
    for (let second = first + 1; second < colors.length; second += 1) {
      minimum = Math.min(minimum, hexDistance(colors[first]!, colors[second]!));
    }
  }
  return minimum;
}

function hexDistance(first: string, second: string) {
  const a = hexChannels(first);
  const b = hexChannels(second);
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function hexChannels(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return {
    b: n & 0xff,
    g: (n >> 8) & 0xff,
    r: (n >> 16) & 0xff,
  };
}
