import { THREAT_BAND_HEX } from "@shared/lib/classification";

import type { DewsAreaBand } from "./world-types";

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
  | "calm"
  | "deep"
  | "harbor"
  | "ledger"
  | "storm"
  | "watch"
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
    accent: "rgba(236, 202, 112, 0.26)",
    base: "#2a7d83",
    inner: "rgba(94, 177, 168, 0.34)",
    texture: "alert",
    wave: "rgba(236, 221, 162, 0.24)",
  },
  "calm-water": {
    accent: "rgba(181, 231, 214, 0.24)",
    base: "#1f9a63",
    inner: "rgba(91, 199, 142, 0.25)",
    texture: "calm",
    wave: "rgba(206, 241, 228, 0.18)",
  },
  "deep-water": {
    accent: "rgba(102, 150, 173, 0.12)",
    base: "#061721",
    inner: "rgba(2, 9, 18, 0.34)",
    texture: "deep",
    wave: "rgba(135, 183, 196, 0.12)",
  },
  "harbor-water": {
    accent: "rgba(171, 219, 205, 0.24)",
    base: "#15858c",
    inner: "rgba(96, 190, 178, 0.29)",
    texture: "harbor",
    wave: "rgba(211, 243, 233, 0.22)",
  },
  "ledger-water": {
    accent: "rgba(217, 185, 116, 0.28)",
    base: "#31594d",
    inner: "rgba(96, 131, 116, 0.3)",
    texture: "ledger",
    wave: "rgba(230, 213, 166, 0.2)",
  },
  "storm-water": {
    accent: "rgba(224, 236, 226, 0.24)",
    base: "#092034",
    inner: "rgba(3, 11, 22, 0.36)",
    texture: "storm",
    wave: "rgba(224, 236, 226, 0.22)",
  },
  "watch-water": {
    accent: "rgba(154, 205, 226, 0.26)",
    base: "#1e6689",
    inner: "rgba(78, 150, 180, 0.28)",
    texture: "watch",
    wave: "rgba(186, 225, 236, 0.2)",
  },
  "warning-water": {
    accent: "rgba(219, 177, 104, 0.34)",
    base: "#344a40",
    inner: "rgba(101, 86, 52, 0.32)",
    texture: "warning",
    wave: "rgba(226, 217, 177, 0.24)",
  },
  water: {
    accent: "rgba(178, 230, 223, 0.21)",
    base: "#0d5f70",
    inner: "rgba(82, 159, 150, 0.2)",
    texture: "water",
    wave: "rgba(203, 239, 231, 0.18)",
  },
} as const satisfies Record<string, WaterTerrainStyle>;

export const DEWS_AREA_LABEL_COLORS = {
  CALM: THREAT_BAND_HEX.CALM,
  WATCH: THREAT_BAND_HEX.WATCH,
  ALERT: THREAT_BAND_HEX.ALERT,
  WARNING: THREAT_BAND_HEX.WARNING,
  DANGER: THREAT_BAND_HEX.DANGER,
} as const satisfies Record<DewsAreaBand, string>;

export function waterTerrainStyle(kind: string): WaterTerrainStyle | null {
  return WATER_TERRAIN_STYLES[kind as keyof typeof WATER_TERRAIN_STYLES] ?? null;
}
