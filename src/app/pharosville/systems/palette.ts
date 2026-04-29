export const HARBOR_PALETTE = {
  deep_sea_2: "#0a0e1d",
  deep_sea_1: "#141a30",
  shallow_teal: "#1f2a4a",
  shallow_teal_lit: "#2d3f6b",
  sky_night: "#0d1226",
  sky_horizon: "#1a2240",
  fog_blue: "#3a4f7a",
  fog_pale: "#5a7099",
  stone_dark: "#2a2620",
  stone_mid: "#4a4238",
  stone_pale: "#6a5e4e",
  iron_dark: "#1a1612",
  timber_dark: "#3a2a1e",
  timber_mid: "#6a4a2e",
  timber_warm: "#8a6840",
  ember: "#2a1a0e",
  lantern_warm: "#d49a3e",
  lantern_glow: "#f7d68a",
  lantern_cold: "#5a8aaa",
  moonlight: "#bfd6e8",
  sail_teal: "#3a5e5a",
  sail_red: "#9a3a2e",
  foam_white: "#e8eef0",
  aurora_green: "#5ea970",
  bloodmoon_red: "#c83a3a",
} as const;

export type HarborPaletteKey = keyof typeof HARBOR_PALETTE;

export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

export function paletteOrThrow(key: HarborPaletteKey): string {
  if (!(key in HARBOR_PALETTE)) {
    throw new Error(`HARBOR_PALETTE: unknown color ${String(key)}`);
  }
  return HARBOR_PALETTE[key];
}

/**
 * Build an `rgba(r, g, b, a)` CSS color string from a palette entry. Used by
 * gradient layers (vignette, horizon haze) where a hex literal can't carry
 * an alpha and a parallel hex constant would defeat the palette guard.
 */
export function paletteRgba(key: HarborPaletteKey, alpha: number): string {
  const hex = HARBOR_PALETTE[key];
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export type WaterTextureKind =
  | "alert"
  | "brackish"
  | "deep"
  | "fog"
  | "frozen"
  | "harbor"
  | "storm"
  | "warning"
  | "water";

export interface WaterTerrainStyle {
  accent: string;
  base: string;
  inner: string;
  wave: string;
  texture: WaterTextureKind;
}

export const WATER_TERRAIN_STYLES = {
  "alert-water": {
    accent: "rgba(236, 202, 112, 0.22)",
    base: "#17485f",
    inner: "rgba(71, 129, 142, 0.32)",
    texture: "alert",
    wave: "rgba(236, 221, 162, 0.2)",
  },
  "brackish-water": {
    accent: "rgba(119, 126, 76, 0.24)",
    base: "#1a3535",
    inner: "rgba(69, 89, 61, 0.3)",
    texture: "brackish",
    wave: "rgba(158, 181, 143, 0.16)",
  },
  "deep-water": {
    accent: "rgba(98, 126, 158, 0.12)",
    base: "#071225",
    inner: "rgba(2, 6, 15, 0.24)",
    texture: "deep",
    wave: "rgba(120, 159, 186, 0.1)",
  },
  "fog-water": {
    accent: "rgba(197, 208, 206, 0.2)",
    base: "#24314a",
    inner: "rgba(197, 208, 206, 0.16)",
    texture: "fog",
    wave: "rgba(209, 223, 215, 0.14)",
  },
  "frozen-water": {
    accent: "rgba(210, 244, 255, 0.28)",
    base: "#315d72",
    inner: "rgba(181, 229, 246, 0.18)",
    texture: "frozen",
    wave: "rgba(219, 248, 255, 0.2)",
  },
  "harbor-water": {
    accent: "rgba(171, 219, 205, 0.2)",
    base: "#1f5f68",
    inner: "rgba(88, 153, 139, 0.24)",
    texture: "harbor",
    wave: "rgba(196, 235, 223, 0.16)",
  },
  "storm-water": {
    accent: "rgba(224, 236, 226, 0.22)",
    base: "#0b2236",
    inner: "rgba(6, 12, 22, 0.28)",
    texture: "storm",
    wave: "rgba(224, 236, 226, 0.18)",
  },
  "warning-water": {
    accent: "rgba(219, 177, 104, 0.3)",
    base: "#1b3448",
    inner: "rgba(80, 69, 47, 0.26)",
    texture: "warning",
    wave: "rgba(226, 217, 177, 0.2)",
  },
  water: {
    accent: "rgba(175, 225, 220, 0.2)",
    base: "#15375a",
    inner: "rgba(88, 153, 139, 0.16)",
    texture: "water",
    wave: "rgba(186, 231, 225, 0.16)",
  },
} as const satisfies Record<string, WaterTerrainStyle>;

export function waterTerrainStyle(kind: string): WaterTerrainStyle | null {
  return WATER_TERRAIN_STYLES[kind as keyof typeof WATER_TERRAIN_STYLES] ?? null;
}
