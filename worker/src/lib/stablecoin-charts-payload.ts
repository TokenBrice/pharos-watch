import {
  StablecoinChartAggregateUniverseSchema,
  type StablecoinChartPoint,
} from "@shared/types/market";
import { sanitizeRecordValues } from "./normalizers";

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
  const pegKeys = new Set<string>();
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
    for (const key of Object.keys(totalCirculatingUSD)) pegKeys.add(key);

    points.push({
      date,
      totalCirculatingUSD,
      ...(aggregateUniverse?.success ? { aggregateUniverse: aggregateUniverse.data } : {}),
    });
  }
  // The feed's observed key union is its cohort census, not evidence of zero before/after a read.
  for (const point of points) {
    for (const key of pegKeys) {
      if (!(key in point.totalCirculatingUSD)) point.totalCirculatingUSD[key] = null;
    }
  }

  return points;
}
