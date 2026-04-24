import type { HealthBand } from "@shared/types/chains";

const HULL_MIN_WIDTH = 28;
const SCENE_OUTER_PADDING = 40;

/**
 * Log10-scaled hull width. Largest chain fills (cardWidth - padding);
 * smallest rendered ship never drops below HULL_MIN_WIDTH.
 */
export function hullWidth(totalUsd: number, maxUsd: number, cardWidth: number): number {
  const innerWidth = Math.max(cardWidth - SCENE_OUTER_PADDING, HULL_MIN_WIDTH);
  if (maxUsd <= 0 || totalUsd <= 0) return HULL_MIN_WIDTH;
  const ratio = Math.log10(totalUsd + 1) / Math.log10(maxUsd + 1);
  return Math.max(HULL_MIN_WIDTH, Math.min(innerWidth, ratio * innerWidth));
}

/** Cargo markers per hull: small boats carry 3, the largest visible hulls carry up to 5. */
export function cargoCapacityForHull(hullW: number): number {
  return Math.max(3, Math.min(5, Math.round(hullW / 18)));
}

/** 1 (shallow) / 2 (mid) / 3 (deep). Thresholds: <5% / 5–15% / ≥15%. */
export function depthLayers(dominanceShare: number): 1 | 2 | 3 {
  if (dominanceShare >= 0.15) return 3;
  if (dominanceShare >= 0.05) return 2;
  return 1;
}

/** Normalized wake length in [-1, 1]. Dead zone below 0.5% magnitude. */
export function wakeLength(change7dPct: number | null | undefined): number {
  if (change7dPct == null) return 0;
  const magnitude = Math.abs(change7dPct);
  if (magnitude < 0.005) return 0;
  const scaled = Math.min(1, magnitude / 0.2);
  return Math.sign(change7dPct) * scaled;
}

/**
 * Returns 'fog' if ≥ 30% of rated chains are fragile or concentrated,
 * otherwise 'sun'. Unrated (null band) chains are excluded from the ratio.
 */
export function aggregateSkyBand(
  entries: readonly { healthBand: HealthBand | null }[],
): "sun" | "fog" {
  const rated = entries.filter((e) => e.healthBand != null);
  if (rated.length === 0) return "sun";
  const unhealthy = rated.filter(
    (e) => e.healthBand === "fragile" || e.healthBand === "concentrated",
  ).length;
  return unhealthy / rated.length >= 0.3 ? "fog" : "sun";
}
