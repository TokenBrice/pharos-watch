import type { StablecoinData, SupplyRestoreMode } from "../types/supply";
import { bucketUnixSecondsToUtcDay } from "./time-buckets";

export type SupplyChangeBaselines = NonNullable<StablecoinData["supplyChangeBaselines"]>;

/** A directly reported USD cap carries its stock clock. A separate valuation must belong to that UTC date. */
export function hasDatedUsdValuation(
  supplySource: string | null | undefined,
  stockAt: number,
  valuationPrice: number | null | undefined,
  valuationAt: number | null | undefined,
  asOf: number,
): boolean {
  if (valuationPrice == null && valuationAt == null) {
    return supplySource === "defillama" || supplySource === "coingecko" || supplySource === "coingecko-fallback";
  }
  return valuationPrice != null && Number.isFinite(valuationPrice) && valuationPrice > 0 &&
    valuationAt != null && Number.isSafeInteger(valuationAt) && valuationAt > 0 && valuationAt <= asOf &&
    bucketUnixSecondsToUtcDay(valuationAt) === bucketUnixSecondsToUtcDay(stockAt);
}

/**
 * Carry-forward ceiling for last-known-good supplemental supply. Restores
 * preserve the original supplyObservedAt, so age compounds run-over-run;
 * without a ceiling a weeks-stale XAUT/PAXG supply would keep publishing into
 * homepage totals indistinguishable from fresh. Past the ceiling the asset
 * publishes with its real (empty) supply and the expiry is reported.
 */
export const SUPPLEMENTAL_RESTORE_MAX_AGE_SEC = 7 * 86400;
export const SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC = 60;

type PegBucketRecord = Record<string, number> | null | undefined;

/**
 * A carry produced by the DefiLlama-outage fallback. Routine main-path carries
 * (chain-dropout repair, coverage restore) keep their existing treatment; only
 * this mode is flagged as an outage restore by PSI and the digest.
 */
export function isOutageFallbackCarry(
  c: { supplyRestored?: boolean; supplyRestoreMode?: SupplyRestoreMode },
): boolean {
  return c.supplyRestored === true && c.supplyRestoreMode === "outage-fallback";
}

export type SupplyBucketInvalidReason = "not-a-record" | "non-finite-bucket" | "negative-bucket" | "overflow";

/**
 * Admission verdict for one provider peg-bucket record (aggregate or chain):
 * `observed` carries the finite nonnegative total (an explicit `0` stays a real zero);
 * `absent` means no bucket was observed (`null`/`undefined`/`{}`);
 * `invalid` names why the record cannot be admitted (never coerced to zero).
 */
export type SupplyBucketAdmission =
  | { status: "observed"; total: number }
  | { status: "absent" }
  | { status: "invalid"; reason: SupplyBucketInvalidReason };

/**
 * Validate an untrusted peg-bucket record at an intake/publication boundary. Every bucket value must be a
 * finite nonnegative number and the sum must stay finite; an empty record is absence, not zero (ADR-28).
 */
export function admitSupplyBuckets(value: unknown): SupplyBucketAdmission {
  if (value == null) return { status: "absent" };
  if (typeof value !== "object" || Array.isArray(value)) return { status: "invalid", reason: "not-a-record" };
  let total = 0;
  let observed = false;
  for (const bucket of Object.values(value as Record<string, unknown>)) {
    if (typeof bucket !== "number" || !Number.isFinite(bucket)) return { status: "invalid", reason: "non-finite-bucket" };
    if (bucket < 0) return { status: "invalid", reason: "negative-bucket" };
    total += bucket;
    observed = true;
  }
  if (!Number.isFinite(total)) return { status: "invalid", reason: "overflow" };
  return observed ? { status: "observed", total } : { status: "absent" };
}

/** Return only admitted totals; absent or invalid buckets remain unavailable. */
export function sumPegBucketsOrNull(obj: PegBucketRecord): number | null {
  const admission = admitSupplyBuckets(obj);
  return admission.status === "observed" ? admission.total : null;
}

/**
 * Sum circulating values across all peg buckets.
 * DefiLlama's list API returns values already in USD for all peg types,
 * so the values we receive here are always in USD — no FX conversion needed.
 *
 * Current and historical accessors preserve unavailable evidence; explicit observed zero remains zero (ADR-28).
 * Canonical current USD supply: null for absent or invalid buckets, including negative/nonfinite values.
 */
export function getCirculatingRawOrNull(
  c: { circulating?: PegBucketRecord } | null | undefined,
): number | null {
  return sumPegBucketsOrNull(c?.circulating);
}

/** Previous-day USD supply; absent or invalid buckets remain null. */
export function getPrevDayRawOrNull(c: { circulatingPrevDay?: PegBucketRecord }): number | null {
  return sumPegBucketsOrNull(c.circulatingPrevDay);
}

/** Previous-week USD supply; absent or invalid buckets remain null. */
export function getPrevWeekRawOrNull(c: { circulatingPrevWeek?: PegBucketRecord }): number | null {
  return sumPegBucketsOrNull(c.circulatingPrevWeek);
}

/** Previous-month USD supply; absent or invalid buckets remain null. */
export function getPrevMonthRawOrNull(c: { circulatingPrevMonth?: PegBucketRecord }): number | null {
  return sumPegBucketsOrNull(c.circulatingPrevMonth);
}

/** V1 readers take historical USD caps from peg buckets. Preserve only evidenced attribution. */
export function projectUsdMarketCapBaselineBuckets(
  asset: { circulating?: PegBucketRecord; supplyChangeBaselines?: SupplyChangeBaselines },
  window: keyof SupplyChangeBaselines,
  legacy: Record<string, number>,
): Record<string, number> {
  const baselines = asset.supplyChangeBaselines;
  const baseline = baselines?.[window];
  if (baseline === null || (baselines && Object.keys(baselines).length === 0)) return {};
  if (baseline === undefined) return legacy;
  const bucketTotal = sumPegBucketsOrNull(legacy);
  const close = baseline.circulatingUsd;
  if (bucketTotal !== null && Math.abs(bucketTotal - close) <= Number.EPSILON * bucketTotal) return legacy;

  // Old Workers sum every bucket. Keep a measured total when D1 cannot apportion it across pegs.
  const keys = Object.keys(asset.circulating ?? {});
  const [peg] = keys;
  return peg && keys.length === 1 && Object.keys(legacy).every((key) => key === peg)
    ? { [peg]: close } : { unattributed: close };
}

/** An empty map records an unsuccessful comparison. Older and partial maps can use legacy buckets. */
export function getUsdMarketCapBaselineOrNull(
  coin: {
    supplyChangeBaselines?: SupplyChangeBaselines;
    circulatingPrevDay?: PegBucketRecord;
    circulatingPrevWeek?: PegBucketRecord;
    circulatingPrevMonth?: PegBucketRecord;
  },
  window: keyof SupplyChangeBaselines,
): number | null {
  const baseline = coin.supplyChangeBaselines?.[window];
  if (baseline !== undefined) {
    return baseline != null && Number.isSafeInteger(baseline.observedAt) && baseline.observedAt > 0
      && Number.isFinite(baseline.circulatingUsd) && baseline.circulatingUsd >= 0 ? baseline.circulatingUsd : null;
  }
  if (coin.supplyChangeBaselines !== undefined && Object.keys(coin.supplyChangeBaselines).length === 0) return null;
  if (window === "day") return getPrevDayRawOrNull(coin);
  return window === "week" ? getPrevWeekRawOrNull(coin) : getPrevMonthRawOrNull(coin);
}
