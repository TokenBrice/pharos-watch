import type { YieldZoneKey } from "@shared/lib/classification";
import { percentileLinear } from "@shared/lib/stats";

export const SAFETY_SCORE_THRESHOLD = 60;

/**
 * Joint safety × yield zone for one row: the exact reading against the row's
 * own benchmark. The scatter quadrants share the vocabulary and the safety
 * split but draw against one chart-wide benchmark as an orientation frame, so
 * a non-USD row can sit visually in a different quadrant than its chip.
 * Null when the row is unscored or has no benchmark to compare to.
 */
export function resolveYieldZone(
  safetyScore: number | null,
  apy30d: number,
  benchmarkRate: number | null | undefined,
): YieldZoneKey | null {
  if (safetyScore === null || benchmarkRate == null || !Number.isFinite(benchmarkRate)) return null;
  const safe = safetyScore >= SAFETY_SCORE_THRESHOLD;
  const paid = apy30d > benchmarkRate;
  if (safe) return paid ? "sweet-spot" : "play-it-safe";
  return paid ? "danger-zone" : "why-bother";
}

const SAFETY_WINDOW_STEP = 5;
const SAFETY_WINDOW_BUFFER = 5;
const APY_AXIS_STEP = 1;
const APY_AXIS_MIN = 8;
const APY_OUTLIER_MIN_ROWS = 12;
const APY_OUTLIER_SHARE = 0.08;
const APY_OUTLIER_RATIO = 1.35;

interface ApyAxisConfig {
  domainMin: number;
  domainMax: number;
  clipThreshold: number | null;
  clippedCount: number;
}

function roundDown(value: number, step: number) {
  return Math.floor(value / step) * step;
}

function roundUp(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

export function computeSafetyDomain(scores: number[], isMobile: boolean): [number, number] {
  if (scores.length === 0) return [0, 100];

  const padding = isMobile ? 2 : 3;
  const minSpan = isMobile ? 25 : 30;

  let start = roundDown(Math.min(...scores) - padding, SAFETY_WINDOW_STEP);
  let end = roundUp(Math.max(...scores) + padding, SAFETY_WINDOW_STEP);

  start = Math.min(start, SAFETY_SCORE_THRESHOLD - SAFETY_WINDOW_BUFFER);
  end = Math.max(end, SAFETY_SCORE_THRESHOLD + SAFETY_WINDOW_BUFFER);

  if (end - start < minSpan) {
    const midpoint = (start + end) / 2;
    start = midpoint - minSpan / 2;
    end = midpoint + minSpan / 2;
  }

  if (start < 0) {
    end = Math.min(100, end - start);
    start = 0;
  }

  if (end > 100) {
    start = Math.max(0, start - (end - 100));
    end = 100;
  }

  start = Math.max(0, roundDown(start, SAFETY_WINDOW_STEP));
  end = Math.min(100, roundUp(end, SAFETY_WINDOW_STEP));

  if (end - start < minSpan) {
    if (start === 0) {
      end = Math.min(100, roundUp(start + minSpan, SAFETY_WINDOW_STEP));
    } else if (end === 100) {
      start = Math.max(0, roundDown(end - minSpan, SAFETY_WINDOW_STEP));
    }
  }

  return [start, end];
}

// ---------------------------------------------------------------------------
// Marker declutter — logos where they fit, exact-position dots where they don't
// ---------------------------------------------------------------------------

export const LOGO_DIAMETER_DESKTOP = 16;
export const LOGO_DIAMETER_MOBILE = 14;
/** Clear space kept between two logo markers, in pixels. */
const LOGO_GAP = 2;

export type ScatterMarkerKind = "logo" | "dot";

interface DeclutterablePoint {
  id: string;
  plotX: number;
  plotY: number;
  tvl: number | null;
}

/**
 * Choose a marker per point without moving any point: larger markets claim a
 * logo first (TVL desc, unavailable TVL last, id as the tie-break); a point
 * whose logo would overlap an already placed logo draws as a small dot at its
 * true position instead. Output is ordered dots first so logos paint on top.
 */
export function declutterScatterMarkers<T extends DeclutterablePoint>(
  points: T[],
  xDomain: [number, number],
  yDomain: [number, number],
  plotWidth: number,
  plotHeight: number,
  mobile: boolean,
): Array<T & { marker: ScatterMarkerKind }> {
  const xSpan = xDomain[1] - xDomain[0];
  const ySpan = yDomain[1] - yDomain[0];
  if (xSpan <= 0 || ySpan <= 0 || plotWidth <= 0 || plotHeight <= 0) {
    return points.map((point) => ({ ...point, marker: "logo" as const }));
  }

  const minDistance = (mobile ? LOGO_DIAMETER_MOBILE : LOGO_DIAMETER_DESKTOP) + LOGO_GAP;
  const toPx = (point: T) => ({
    x: ((point.plotX - xDomain[0]) / xSpan) * plotWidth,
    y: ((point.plotY - yDomain[0]) / ySpan) * plotHeight,
  });

  const byPriority = [...points].sort(
    (a, b) => (b.tvl ?? -Infinity) - (a.tvl ?? -Infinity) || a.id.localeCompare(b.id),
  );
  const placed: Array<{ x: number; y: number }> = [];
  const markers = new Map<string, ScatterMarkerKind>();
  for (const point of byPriority) {
    const px = toPx(point);
    const collides = placed.some((other) => Math.hypot(other.x - px.x, other.y - px.y) < minDistance);
    if (collides) {
      markers.set(point.id, "dot");
    } else {
      placed.push(px);
      markers.set(point.id, "logo");
    }
  }

  const withMarkers = points.map((point) => ({ ...point, marker: markers.get(point.id) ?? ("logo" as const) }));
  return [...withMarkers.filter((point) => point.marker === "dot"), ...withMarkers.filter((point) => point.marker === "logo")];
}

// ---------------------------------------------------------------------------
// APY axis computation
// ---------------------------------------------------------------------------

export function computeApyAxis(apys: number[], riskFreeRate: number): ApyAxisConfig {
  if (apys.length === 0) {
    return {
      domainMin: 0,
      domainMax: Math.max(APY_AXIS_MIN, roundUp(riskFreeRate + 4, APY_AXIS_STEP)),
      clipThreshold: null,
      clippedCount: 0,
    };
  }

  const sorted = [...apys].sort((a, b) => a - b);
  // Keep the entire losing tail on the same linear scale; only the upper tail
  // has a disclosed display rail.
  const domainMin = Math.min(0, roundDown(sorted[0] * 1.08, APY_AXIS_STEP));
  const naturalMax = sorted[sorted.length - 1];
  const paddedMax = roundUp(Math.max(riskFreeRate + 4, naturalMax * 1.08), APY_AXIS_STEP);
  const q75 = percentileLinear(sorted, 75) ?? 0;
  const q90 = percentileLinear(sorted, 90) ?? 0;
  const candidateThreshold = roundUp(Math.max(riskFreeRate + 6, q75 + 3, q90 * 1.25), APY_AXIS_STEP);
  const clippedCount = sorted.filter((value) => value > candidateThreshold).length;
  const maxOutliers = Math.max(1, Math.floor(sorted.length * APY_OUTLIER_SHARE));
  const shouldClip =
    sorted.length >= APY_OUTLIER_MIN_ROWS &&
    clippedCount > 0 &&
    clippedCount <= maxOutliers &&
    naturalMax >= candidateThreshold * APY_OUTLIER_RATIO;

  if (!shouldClip) {
    return {
      domainMin,
      domainMax: Math.max(APY_AXIS_MIN, paddedMax),
      clipThreshold: null,
      clippedCount: 0,
    };
  }

  return {
    domainMin,
    domainMax: Math.max(APY_AXIS_MIN, candidateThreshold),
    clipThreshold: candidateThreshold,
    clippedCount,
  };
}
