import { isFiniteNumber } from "./type-guards";

/** Safely coerce to number, treating null/undefined/NaN/Infinity as 0 */
const safeNum = (v: number | null | undefined): number => isFiniteNumber(v) ? v : 0;

type PegBucketRecord = Record<string, number> | null | undefined;

/** Sum all values in a peg-bucket record, treating missing/invalid entries as 0. */
export function sumPegBuckets(obj: PegBucketRecord): number {
  if (!obj) return 0;
  return Object.values(obj).reduce((s, v) => s + safeNum(v), 0);
}

/** Return true when at least one peg bucket has an explicit finite numeric value, including zero. */
function hasAnyBucket(obj: PegBucketRecord): boolean {
  if (!obj) return false;
  return Object.values(obj).some((v) => isFiniteNumber(v));
}

/** Sum peg buckets, returning `null` when the record carries no explicit bucket at all — the absent/zero discriminant. */
export function sumPegBucketsOrNull(obj: PegBucketRecord): number | null {
  const val = sumPegBuckets(obj);
  return val === 0 && !hasAnyBucket(obj) ? null : val;
}

/**
 * Sum circulating values across all peg buckets.
 * DefiLlama's list API returns values already in USD for all peg types,
 * so the values we receive here are always in USD — no FX conversion needed.
 *
 * Reserved for callers that have already established availability — absent, empty and wholly-invalid buckets
 * collapse to `0` here. Callers that must keep "no supply data" distinct from a genuine zero read
 * `getCirculatingRawOrNull()`; migrating them off this default is owned by plan task P1-05.
 */
export function getCirculatingRaw(c: { circulating?: PegBucketRecord }): number {
  return sumPegBuckets(c.circulating);
}

/**
 * Canonical absence-preserving current supply: `null` when the asset is missing from the payload, or its peg buckets
 * are absent, empty or wholly invalid; `0` only for an explicit finite zero. Shares its
 * `sumPegBucketsOrNull`/`hasAnyBucket` discriminant with the historical `*OrNull` helpers.
 */
export function getCirculatingRawOrNull(
  c: { circulating?: PegBucketRecord } | null | undefined,
): number | null {
  return sumPegBucketsOrNull(c?.circulating);
}

/** Previous-day USD circulating, with missing buckets coerced to 0. Use the `*OrNull` variant when you need to distinguish "no data" from "zero". */
export function getPrevDayRaw(c: { circulatingPrevDay?: PegBucketRecord }): number {
  return sumPegBuckets(c.circulatingPrevDay);
}

/** Returns null when the prev-day bucket is entirely absent/empty, so callers can avoid plotting a false 0 in deltas/sparklines. */
export function getPrevDayRawOrNull(c: { circulatingPrevDay?: PegBucketRecord }): number | null {
  return sumPegBucketsOrNull(c.circulatingPrevDay);
}

/** Previous-week USD circulating, with missing buckets coerced to 0. Use `getPrevWeekRawOrNull` for "no data" vs "zero" disambiguation. */
export function getPrevWeekRaw(c: { circulatingPrevWeek?: PegBucketRecord }): number {
  return sumPegBuckets(c.circulatingPrevWeek);
}

/** Returns null when the prev-week bucket is entirely absent/empty. */
export function getPrevWeekRawOrNull(c: { circulatingPrevWeek?: PegBucketRecord }): number | null {
  return sumPegBucketsOrNull(c.circulatingPrevWeek);
}

/** Returns null when the prev-month bucket is entirely absent/empty. No 0-defaulting variant exists because monthly callers always need the absent/zero distinction. */
export function getPrevMonthRawOrNull(c: { circulatingPrevMonth?: PegBucketRecord }): number | null {
  return sumPegBucketsOrNull(c.circulatingPrevMonth);
}
