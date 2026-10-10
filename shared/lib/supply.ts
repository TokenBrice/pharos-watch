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
