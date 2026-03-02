// src/lib/dews-radar-utils.ts
import type { ThreatBand } from "@/lib/classification";

type ElevatedBand = Exclude<ThreatBand, "CALM">;

const BAND_SCORE: Record<ElevatedBand, [number, number]> = {
  WATCH:   [16, 35],
  ALERT:   [36, 55],
  WARNING: [56, 75],
  DANGER:  [76, 100],
};

const BAND_RADIUS: Record<ElevatedBand, [number, number]> = {
  WATCH:   [75,  108],
  ALERT:   [118, 151],
  WARNING: [161, 194],
  DANGER:  [204, 240],
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

const BAND_ORDER: ThreatBand[] = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];

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
  const sum = id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return ((sum % 30) * Math.PI) / 180;
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
  let maxIdx = 0;
  for (const b of bands) {
    const idx = BAND_ORDER.indexOf(b as ThreatBand);
    if (idx > maxIdx) maxIdx = idx;
  }
  return BAND_ORDER[maxIdx];
}

/** Sweep revolution duration in seconds for a given system threat level. */
export function sweepDuration(band: ThreatBand): number {
  return SWEEP_DURATION[band];
}

/** Dot pulse animation duration in seconds for a given non-CALM band. */
export function pulseDuration(band: ElevatedBand): number {
  return PULSE_DURATION[band];
}
