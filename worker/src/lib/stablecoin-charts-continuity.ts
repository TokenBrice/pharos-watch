import type { StablecoinChartPoint } from "@shared/types/market";

/**
 * Continuity budgets for the published stablecoin chart history. The producer
 * samples daily/weekly/monthly points, so a healthy publication only adds a
 * point and moves the oldest boundary by one sampling interval (30 days in the
 * oldest tier). The bands are wide enough for sampling-boundary drift and FX
 * repairs while catching a truncated history or a lost currency series.
 */
export const STABLECOIN_CHART_CONTINUITY_THRESHOLDS = {
  /** New publications below this share of the previous point count are truncated. */
  minPointShare: 0.8,
  /** Tolerated forward movement of the oldest point beyond the 30-day sampling tier. */
  maxOldestDateAdvanceSec: 45 * 24 * 3600,
  perBucketRatioFloor: 0.5,
  perBucketRatioCeiling: 2,
} as const;

export type ChartContinuityCode =
  | "point-count-collapse"
  | "history-start-truncated"
  | "bucket-missing"
  | "bucket-value-drift";

export interface ChartContinuityFinding {
  code: ChartContinuityCode;
  /** Previous / next measurements behind the finding. */
  previous: number;
  next: number;
  bucket?: string;
}

function latestPoint(points: readonly StablecoinChartPoint[]): StablecoinChartPoint | null {
  let latest: StablecoinChartPoint | null = null;
  for (const point of points) {
    if (latest == null || point.date > latest.date) latest = point;
  }
  return latest;
}

/**
 * Compare a candidate publication with the previously published payload. An
 * absent or empty baseline returns no findings (nothing to preserve); the
 * caller reports that absence rather than treating it as healthy continuity.
 */
export function assessStablecoinChartContinuity(
  previous: readonly StablecoinChartPoint[],
  next: readonly StablecoinChartPoint[],
): ChartContinuityFinding[] {
  if (previous.length === 0) return [];
  const findings: ChartContinuityFinding[] = [];
  if (next.length === 0) {
    return [{ code: "point-count-collapse", previous: previous.length, next: 0 }];
  }
  if (next.length < previous.length * STABLECOIN_CHART_CONTINUITY_THRESHOLDS.minPointShare) {
    findings.push({ code: "point-count-collapse", previous: previous.length, next: next.length });
  }

  const previousOldest = Math.min(...previous.map((point) => point.date));
  const nextOldest = Math.min(...next.map((point) => point.date));
  if (nextOldest - previousOldest > STABLECOIN_CHART_CONTINUITY_THRESHOLDS.maxOldestDateAdvanceSec) {
    findings.push({ code: "history-start-truncated", previous: previousOldest, next: nextOldest });
  }

  const previousLatest = latestPoint(previous);
  const nextLatest = latestPoint(next);
  if (previousLatest && nextLatest) {
    for (const [bucket, previousValue] of Object.entries(previousLatest.totalCirculatingUSD)) {
      // An unavailable previous bucket is not evidence that a series existed.
      if (previousValue == null || !Number.isFinite(previousValue) || previousValue <= 0) continue;
      const nextValue = nextLatest.totalCirculatingUSD[bucket];
      if (nextValue === undefined) {
        findings.push({ code: "bucket-missing", previous: 1, next: 0, bucket });
        continue;
      }
      if (nextValue == null) continue;
      if (!Number.isFinite(nextValue) || nextValue < 0) {
        findings.push({ code: "bucket-value-drift", previous: previousValue, next: nextValue, bucket });
        continue;
      }
      const ratio = nextValue / previousValue;
      if (ratio < STABLECOIN_CHART_CONTINUITY_THRESHOLDS.perBucketRatioFloor
        || ratio > STABLECOIN_CHART_CONTINUITY_THRESHOLDS.perBucketRatioCeiling) {
        findings.push({ code: "bucket-value-drift", previous: previousValue, next: nextValue, bucket });
      }
    }
  }
  return findings;
}
