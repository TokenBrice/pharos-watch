import { ReserveFeedReviewSchema, type ReserveFeedReview } from "@shared/types/live-reserves";
import { RESERVE_FEED_REVIEW_MAX_AGE_SEC } from "@shared/lib/status-thresholds";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { getConfiguredLiveReserveCoins, type ReserveSyncStateRecord } from "./live-reserves/store-shared";
import { loadLatestNonSkippedReserveAttempt, type ReserveSyncAttemptTimelineEntry } from "./live-reserves/store-history-read";

/** Dated operational acknowledgements: no snapshot, scoring, or freshness authority. */
export const RESERVE_FEED_REVIEWS: readonly ReserveFeedReview[] = [
  {
    stablecoinId: "yzusd-yuzu", adapterKey: "accountable", failureCategory: "unknown",
    warningCodes: [], errorPrefix: "primary:http-json: Accountable exposure_split has no contemporaneous timeline reserve total for reconciliation",
    owner: "ops", reason: "GET observed 2026-10-29 11:02 UTC (dashboard envelope ts 2026-10-29T09:31:06.327Z): the October 29 08:17:01 UTC exposure_split advances, but the dated `reserves.timeline` rows stamped 2026-10-26, 10-27 and 10-28 still repeat ts 2026-10-25T23:47:36.638Z with reserves $63,780,754.42, and the 2026-10-29 row carries only the live envelope clock the adapter never uses as an anchor. The nearest non-live bracket is therefore 289,765 seconds (3.35 days) older than exposure_split_ts, beyond the unchanged 24-hour bracket window, so the split has no contemporaneous reserve total to reconcile against and the attempt fails closed. The split itself still totals $63,882,663.77 across 25 buckets against a $63,651,564.07 total_reserves (+$231,099.70, 0.36%) and would reconcile inside the unchanged 1% bound once the issuer refreshes the timeline; no reconciliation, freshness or scoring exception is granted here. Keep the snapshot quarantined and original clocks unchanged pending issuer-side timeline repair; this acknowledgement spans only this stale-timeline category and error text, and a bucket-total, invalid-value or transport failure is a different cause.",
    sources: [{ url: "https://cache.accountable.capital/dashboard/yuzu", evidenceDate: "2026-10-29" }],
    reviewedAt: Date.UTC(2026, 9, 29, 11, 2) / 1000,
    expiresAt: Date.UTC(2026, 10, 5, 11, 2) / 1000,
  },
];

export function resolveReserveFeedReviews(
  now: number,
  reviews: readonly ReserveFeedReview[] = RESERVE_FEED_REVIEWS,
) {
  const configured = new Map(getConfiguredLiveReserveCoins().map((coin) => [coin.id, coin]));
  const activeById = new Map<string, ReserveFeedReview>();
  const expiredIds: string[] = [];
  const invalidIds: string[] = [];
  const duplicateIds = new Set(reviews.filter((review, index) =>
    reviews.findIndex((other) => other.stablecoinId === review.stablecoinId) !== index).map((review) => review.stablecoinId));
  for (const review of reviews) {
    const parsed = ReserveFeedReviewSchema.safeParse(review);
    const config = configured.get(review.stablecoinId)?.liveReservesConfig;
    const evidenceClass = config ? getLiveReserveAdapterDefinition(config.adapter)?.evidenceClass : null;
    const validDates = parsed.success && review.sources.every(({ evidenceDate }) => {
      const time = Date.parse(`${evidenceDate}T00:00:00Z`);
      return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === evidenceDate && time / 1000 <= review.reviewedAt;
    });
    if (!parsed.success || duplicateIds.has(review.stablecoinId) || config?.adapter !== review.adapterKey
      || (evidenceClass !== "independent" && evidenceClass !== "static-validated")
      || !validDates || review.reviewedAt > now || review.expiresAt <= review.reviewedAt
      || review.expiresAt - review.reviewedAt > RESERVE_FEED_REVIEW_MAX_AGE_SEC
      || (review.warningCodes.length === 0 && review.errorPrefix == null)) {
      invalidIds.push(review.stablecoinId);
    } else if (now >= review.expiresAt) {
      expiredIds.push(review.stablecoinId);
    } else {
      activeById.set(review.stablecoinId, review);
    }
  }
  return { activeById, expiredIds: [...new Set(expiredIds)], invalidIds: [...new Set(invalidIds)] };
}

/**
 * Exact-failure acknowledgements for the reserve alerting predicates: a coin is
 * returned only when an unexpired review matches its adapter, failure category,
 * complete warning set and full error. Failure readings are fail-closed — an
 * unreadable match or circuit history never suppresses an alert.
 */
export async function resolveAcknowledgedReserveFeedIds(
  db: D1Database,
  states: Iterable<ReserveSyncStateRecord>,
  now: number,
): Promise<Set<string>> {
  const activeById = resolveReserveFeedReviews(now).activeById;
  const acknowledged = new Set<string>();
  for (const state of states) {
    if (!activeById.has(state.stablecoinId)) continue;
    try {
      const review = await matchReserveFeedReview(db, state, now, activeById);
      if (review !== null && now < review.expiresAt) acknowledged.add(state.stablecoinId);
    } catch {
      // Fail closed: the alert stays eligible rather than inheriting a review.
    }
  }
  return acknowledged;
}

export async function matchReserveFeedReview(
  db: D1Database,
  state: ReserveSyncStateRecord | null,
  now: number,
  reviewsById = resolveReserveFeedReviews(now).activeById,
): Promise<ReserveFeedReview | null> {
  if (!state || state.metadata.uncertainWrite === true) return null;
  // Unreadable stored warnings are not an empty set: the strict decoder could
  // not corroborate the review's exact-warning match, so the alert stays eligible.
  if (state.warningIntegrityIssue || state.warningCount !== state.warnings.length) return null;
  const review = reviewsById.get(state.stablecoinId);
  if (!review || review.adapterKey !== state.adapterKey) return null;
  let failure: Pick<ReserveSyncAttemptTimelineEntry, "adapterKey" | "status" | "failureCategory" | "warningCodes" | "lastError"> = {
    adapterKey: state.adapterKey, status: state.lastStatus,
    failureCategory: typeof state.metadata.failureCategory === "string" ? state.metadata.failureCategory : null,
    warningCodes: state.warnings.map((warning) => warning.code), lastError: state.lastError,
  };
  if (state.lastStatus === "skipped" && state.metadata.failureCategory === "circuit-open") {
    try {
      const prior = await loadLatestNonSkippedReserveAttempt(db, state.stablecoinId);
      if (!prior) return null;
      failure = prior;
    } catch { return null; }
  }
  if (failure.status !== "error" && failure.status !== "degraded") return null;
  if (failure.failureCategory === "adapter-timeout" || failure.failureCategory === "run-budget-exhausted"
    || failure.lastError?.includes("future-portfolio-timestamp")) return null;
  if (failure.adapterKey !== review.adapterKey || failure.failureCategory !== review.failureCategory) return null;
  // Exact warning set prevents a new fatal condition inheriting an old review.
  if (failure.warningCodes.length !== review.warningCodes.length
    || failure.warningCodes.some((code) => !review.warningCodes.includes(code))) return null;
  if (failure.lastError !== review.errorPrefix) return null;
  return review;
}
