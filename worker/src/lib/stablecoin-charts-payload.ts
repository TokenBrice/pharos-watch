import {
  StablecoinChartAggregateUniverseSchema,
  type StablecoinChartPoint,
} from "@shared/types";
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

function normalizeStablecoinChartBuckets(value: unknown): Record<string, number> | null {
  const buckets = sanitizeRecordValues(value, (raw) => {
    const numeric = coerceFiniteNumber(raw);
    return numeric == null ? undefined : numeric;
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
