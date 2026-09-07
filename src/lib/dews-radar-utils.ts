// src/lib/dews-radar-utils.ts
import { THREAT_BAND_ORDER, isThreatBand, type ThreatBand } from "@shared/lib/classification";
import { DEWS_THREAT_BANDS } from "@shared/lib/dews-config";
import { deterministicHash } from "@/lib/layout-utils";

type ElevatedBand = Exclude<ThreatBand, "CALM">;

// Score intervals follow the shared DEWS band ladder: each elevated band spans the previous band's upper + 1 through its own.
const BAND_SCORE = Object.fromEntries(
  DEWS_THREAT_BANDS.slice(1).map(({ band, upper }, index) => [band, [DEWS_THREAT_BANDS[index].upper + 1, upper]]),
) as Record<ElevatedBand, [number, number]>;

const BAND_RADIUS: Record<ElevatedBand, [number, number]> = {
  WATCH:   [178, 208],
  ALERT:   [143, 175],
  WARNING: [95,  140],
  DANGER:  [45,  90],
};

const SWEEP_DURATION: Record<ThreatBand, number> = {
  CALM:    12,
  WATCH:   8,
  ALERT:   6,
  WARNING: 4,
  DANGER:  2.5,
};

const PULSE_DURATION: Record<ElevatedBand, number> = {
  WATCH:   3.0,
  ALERT:   2.0,
  WARNING: 1.2,
  DANGER:  0.6,
};

/**
 * Map a coin's score to a radius within its band's radial zone.
 * scoreMin → innerR, scoreMax → outerR, linear interpolation in between.
 */
export function scoreToRadius(score: number, band: ElevatedBand): number {
  const [scoreMin, scoreMax] = BAND_SCORE[band];
  const [innerR, outerR] = BAND_RADIUS[band];
  const t = Math.max(0, Math.min(1, (score - scoreMin) / (scoreMax - scoreMin)));
  return innerR + t * (outerR - innerR);
}

/**
 * Small deterministic angular jitter from a coin ID string, in radians.
 * Same id always returns same value. Range: [0, π/6).
 */
export function deterministicOffset(id: string): number {
  if (id.length === 0) return 0;
  const hash = deterministicHash(id);
  return ((hash % 30) * Math.PI) / 180;
}

/**
 * Deterministic radius offset within a zone, derived from a coin ID string.
 * Same id + zoneWidth always returns the same value. Range: [0, zoneWidth).
 */
export function deterministicRadiusOffset(id: string, zoneWidth: number): number {
  if (id.length === 0) return 0;
  if (zoneWidth <= 0) return 0;
  return deterministicHash(id) % zoneWidth;
}

/**
 * N equally-spaced base angles starting at 12 o'clock (-π/2), clockwise.
 */
export function distributeAngles(n: number): number[] {
  if (n === 0) return [];
  const step = (2 * Math.PI) / n;
  return Array.from({ length: n }, (_, i) => -Math.PI / 2 + i * step);
}

/**
 * The highest threat band across a set of band strings.
 * Returns "CALM" if none are elevated.
 */
export function highestBand(bands: string[]): ThreatBand {
  let highest: ThreatBand = "CALM";
  for (const b of bands) {
    if (!isThreatBand(b)) continue;
    if (THREAT_BAND_ORDER[b] > THREAT_BAND_ORDER[highest]) highest = b;
  }
  return highest;
}

/** Sweep revolution duration in seconds for a given system threat level. */
export function sweepDuration(band: ThreatBand): number {
  return SWEEP_DURATION[band];
}

/** Dot pulse animation duration in seconds for a given non-CALM band. */
export function pulseDuration(band: ElevatedBand): number {
  return PULSE_DURATION[band];
}
