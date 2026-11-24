import {
  CORE_STABLECOIN_AGGREGATE_UNIVERSES,
  CoreStablecoinAggregateUniverseSchema,
  type CoreStablecoinAggregateUniverse,
} from "@shared/lib/stablecoins/aggregate-universe";
import type { StablecoinChartPoint } from "@shared/types/supply";
import { parseJson } from "./json-parse";

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

/** Sibling cache key tracking the published aggregate perimeter identity for `stablecoin-charts`. */
export const STABLECOIN_CHARTS_PERIMETER_CACHE_KEY = "stablecoin-charts:perimeter" as const;

export interface StablecoinChartsPerimeterRecord {
  universe: CoreStablecoinAggregateUniverse;
  cutoverDate: string;
  acceptedFromUniverse?: CoreStablecoinAggregateUniverse;
  acceptedAt?: number;
}

export function parseStablecoinChartsPerimeterRecord(raw: string): StablecoinChartsPerimeterRecord | null {
  const parsed = parseJson(raw);
  if (!parsed.ok || parsed.value == null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return null;
  }
  const value = parsed.value as Record<string, unknown>;
  const universe = CoreStablecoinAggregateUniverseSchema.safeParse(value.universe);
  if (!universe.success || typeof value.cutoverDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.cutoverDate)) {
    return null;
  }
  const acceptedFrom = value.acceptedFromUniverse === undefined
    ? null
    : CoreStablecoinAggregateUniverseSchema.safeParse(value.acceptedFromUniverse);
  if (acceptedFrom && !acceptedFrom.success) return null;
  if (value.acceptedAt !== undefined && (typeof value.acceptedAt !== "number" || !Number.isFinite(value.acceptedAt) || value.acceptedAt <= 0)) {
    return null;
  }
  return {
    universe: universe.data,
    cutoverDate: value.cutoverDate,
    ...(acceptedFrom?.success ? { acceptedFromUniverse: acceptedFrom.data } : {}),
    ...(typeof value.acceptedAt === "number" ? { acceptedAt: value.acceptedAt } : {}),
  };
}

export type ChartContinuityCode =
  | "point-count-collapse"
  | "history-start-truncated"
  | "bucket-missing"
  | "bucket-value-drift";

export interface ChartContinuityFinding {
  code: ChartContinuityCode;
  previous: number;
  next: number;
  bucket?: string;
}

export interface ChartContinuityOptions {
  previousUniverse?: CoreStablecoinAggregateUniverse | null;
  nextUniverse?: CoreStablecoinAggregateUniverse | null;
}

export interface ChartContinuityAssessment {
  blockingFindings: ChartContinuityFinding[];
  acceptedCutoverFindings: ChartContinuityFinding[];
}

function isKnownUniverse(value: unknown): value is CoreStablecoinAggregateUniverse {
  return typeof value === "string"
    && (CORE_STABLECOIN_AGGREGATE_UNIVERSES as readonly string[]).includes(value);
}

function latestPoint(points: readonly StablecoinChartPoint[]): StablecoinChartPoint | null {
  let latest: StablecoinChartPoint | null = null;
  for (const point of points) {
    if (latest == null || point.date > latest.date) latest = point;
  }
  return latest;
}

/**
 * Compare a candidate publication with the previously published payload.
 * When `previousUniverse !== nextUniverse` (both valid known core aggregate
 * universes), finite non-negative bucket-value drift and non-USD bucket
 * disappearances are accepted once and returned in `acceptedCutoverFindings`
 * so a planned perimeter cutover publishes cleanly without freezing in
 * `degraded`. Truncation, point-count collapse, invalid bucket values, and
 * `peggedUSD` disappearance always remain blocking.
 */
export function assessStablecoinChartContinuityWithCutover(
  previous: readonly StablecoinChartPoint[],
  next: readonly StablecoinChartPoint[],
  options: ChartContinuityOptions = {},
): ChartContinuityAssessment {
  if (previous.length === 0) {
    return { blockingFindings: [], acceptedCutoverFindings: [] };
  }
  const blockingFindings: ChartContinuityFinding[] = [];
  const acceptedCutoverFindings: ChartContinuityFinding[] = [];
  if (next.length === 0) {
    return {
      blockingFindings: [{ code: "point-count-collapse", previous: previous.length, next: 0 }],
      acceptedCutoverFindings: [],
    };
  }
  if (next.length < previous.length * STABLECOIN_CHART_CONTINUITY_THRESHOLDS.minPointShare) {
    blockingFindings.push({ code: "point-count-collapse", previous: previous.length, next: next.length });
  }

  const previousOldest = Math.min(...previous.map((point) => point.date));
  const nextOldest = Math.min(...next.map((point) => point.date));
  if (nextOldest - previousOldest > STABLECOIN_CHART_CONTINUITY_THRESHOLDS.maxOldestDateAdvanceSec) {
    blockingFindings.push({ code: "history-start-truncated", previous: previousOldest, next: nextOldest });
  }

  const isPlannedCutover =
    isKnownUniverse(options.previousUniverse)
    && isKnownUniverse(options.nextUniverse)
    && options.previousUniverse !== options.nextUniverse;

  const previousLatest = latestPoint(previous);
  const nextLatest = latestPoint(next);
  if (previousLatest && nextLatest) {
    for (const [bucket, previousValue] of Object.entries(previousLatest.totalCirculatingUSD)) {
      // An unavailable previous bucket is not evidence that a series existed.
      if (previousValue == null || !Number.isFinite(previousValue) || previousValue <= 0) continue;
      const nextValue = nextLatest.totalCirculatingUSD[bucket];
      if (nextValue === undefined) {
        const finding: ChartContinuityFinding = { code: "bucket-missing", previous: 1, next: 0, bucket };
        if (isPlannedCutover && bucket !== "peggedUSD") {
          acceptedCutoverFindings.push(finding);
        } else {
          blockingFindings.push(finding);
        }
        continue;
      }
      if (nextValue == null) continue;
      if (!Number.isFinite(nextValue) || nextValue < 0) {
        blockingFindings.push({ code: "bucket-value-drift", previous: previousValue, next: nextValue, bucket });
        continue;
      }
      const ratio = nextValue / previousValue;
      if (ratio < STABLECOIN_CHART_CONTINUITY_THRESHOLDS.perBucketRatioFloor
        || ratio > STABLECOIN_CHART_CONTINUITY_THRESHOLDS.perBucketRatioCeiling) {
        const finding: ChartContinuityFinding = { code: "bucket-value-drift", previous: previousValue, next: nextValue, bucket };
        if (isPlannedCutover) {
          acceptedCutoverFindings.push(finding);
        } else {
          blockingFindings.push(finding);
        }
      }
    }
  }
  return { blockingFindings, acceptedCutoverFindings };
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
  return assessStablecoinChartContinuityWithCutover(previous, next).blockingFindings;
}
