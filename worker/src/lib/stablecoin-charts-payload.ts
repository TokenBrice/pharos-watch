import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  StablecoinChartAggregateUniverseSchema,
  type StablecoinChartPoint,
} from "@shared/types/market";
import { sanitizeRecordValues } from "./normalizers";

/** Sample admitted chronological points without sorting or changing their payloads. */
export function sampleHistoricalDatePoints<T extends { date: number }>(points: readonly T[], nowSec: number): T[] {
  const sampled: T[] = [];
  let lastKeptDate = 0;
  for (const point of points) {
    const interval = point.date >= nowSec - 90 * DAY_SECONDS
      ? DAY_SECONDS
      : point.date >= nowSec - 2 * 365 * DAY_SECONDS ? 7 * DAY_SECONDS : 30 * DAY_SECONDS;
    if (point.date - lastKeptDate >= interval) {
      sampled.push(point);
      lastKeptDate = point.date;
    }
  }
  return sampled;
}

function coerceFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    return undefined;
  }
  return numeric;
}

export function normalizeStablecoinChartDateSeconds(value: unknown): number | null {
  const numeric = coerceFiniteNumber(value);
  if (numeric == null || numeric <= 0) {
    return null;
  }
  return Math.trunc(numeric);
}

export function normalizeStablecoinChartBuckets(value: unknown): Record<string, number | null> | null {
  const buckets = sanitizeRecordValues(value, (raw) => {
    const numeric = typeof raw === "string" && raw.trim() === "" ? undefined : coerceFiniteNumber(raw);
    return numeric == null || numeric < 0 ? null : numeric;
  });
  return Object.keys(buckets).length > 0 ? buckets : null;
}

export function normalizeStablecoinChartPoints(payload: unknown): StablecoinChartPoint[] | null {
  if (!Array.isArray(payload)) return null;

  const points: StablecoinChartPoint[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") return null;

    const date = normalizeStablecoinChartDateSeconds((entry as { date?: unknown }).date);
    const totalCirculatingUSD = normalizeStablecoinChartBuckets(
      (entry as { totalCirculatingUSD?: unknown }).totalCirculatingUSD,
    );

    if (date == null || totalCirculatingUSD == null) {
      return null;
    }

    const aggregateUniverseValue = (entry as { aggregateUniverse?: unknown }).aggregateUniverse;
    const aggregateUniverse = aggregateUniverseValue === undefined
      ? undefined
      : StablecoinChartAggregateUniverseSchema.safeParse(aggregateUniverseValue);
    if (aggregateUniverse && !aggregateUniverse.success) return null;

    points.push({
      date,
      totalCirculatingUSD,
      ...(aggregateUniverse?.success ? { aggregateUniverse: aggregateUniverse.data } : {}),
    });
  }

  return points;
}
