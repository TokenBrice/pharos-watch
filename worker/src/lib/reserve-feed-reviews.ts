import { ReserveFeedReviewSchema, type ReserveFeedReview } from "@shared/types/live-reserves";
import { RESERVE_FEED_REVIEW_MAX_AGE_SEC } from "@shared/lib/status-thresholds";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { getConfiguredLiveReserveCoins, type ReserveSyncStateRecord } from "./live-reserves/store-shared";
import { loadLatestNonSkippedReserveAttempt, type ReserveSyncAttemptTimelineEntry } from "./live-reserves/store-history-read";

const reviewedAt = Date.UTC(2026, 9, 6) / 1000;
const expiresAt = Date.UTC(2026, 9, 13) / 1000;
const staleReport = (stablecoinId: string, url: string, evidenceDate: string): ReserveFeedReview => ({
  stablecoinId, adapterKey: "attestation-pdf-index", failureCategory: "validation",
  warningCodes: ["stale-redemption-source-timestamp"], errorPrefix: "Validation failed: Redemption source timestamp",
  owner: "ops", reason: `Official balance-date ${evidenceDate} evidence remains outside the unchanged source-age budget; awaiting issuer publication.`,
  sources: [{ url, evidenceDate }], reviewedAt, expiresAt,
});

/** Dated operational acknowledgements: no snapshot, scoring, or freshness authority. */
export const RESERVE_FEED_REVIEWS: readonly ReserveFeedReview[] = [
  ...["wars-argentine-peso", "wbrl-ripio", "wcop-ripio", "wmxn-ripio"].map((id) =>
    staleReport(id, "https://action.ripio.com/en/wfiat-attestations", "2026-06-30")),
  staleReport("usdu-universal", "https://www.universal.ae/transparency", "2026-08-31"),
  staleReport("zarp-zarp", "https://www.zarpstablecoin.com/transparency/", "2026-08-31"),
  staleReport("zarsc-supercoin", "https://www.supercoin.co.za/assurance-reports", "2026-08-31"),
  {
    stablecoinId: "gusd-gemini", adapterKey: "gemini-independent-assurance", failureCategory: "unknown",
    warningCodes: [], errorPrefix: "primary:http-json: gemini-independent-assurance: newer unreviewed report on official index",
    owner: "ops", reason: "2026-10-06 official index finding requires review of a newer assurance report; this acknowledges review debt, not report freshness.",
    sources: [{ url: "https://www.gemini.com/dollar", evidenceDate: "2026-10-06" }], reviewedAt, expiresAt,
  },
  {
    stablecoinId: "mtbill-midas", adapterKey: "midas-mtbill", failureCategory: "unknown",
    warningCodes: [], errorPrefix: "primary:http-json: midas-mtbill:stale-portfolio-timestamp",
    owner: "ops", reason: "Portfolio source clock 2026-09-18T12:06:10.121Z, captured 2026-10-06T07:49:04Z, exceeds the unchanged three-day budget. Only the explicit stale token is reviewed, never future clocks.",
    sources: [{ url: "https://api-prod.midas.app/api/transparency?token=mTBILL", evidenceDate: "2026-09-18" }], reviewedAt, expiresAt,
  },
];

// Inactive research candidates have no health-exclusion authority.
export const RESERVE_FEED_REVIEW_CANDIDATES = [{
  stablecoinId: "yzusd-yuzu",
  reason: "2026-10-06 buckets $62,242,674.629 versus reserves $64,288,465.66; establish issuer-side mismatch before activation.",
  sources: ["https://cache.accountable.capital/dashboard/yuzu", "https://yuzu.accountable.capital/"],
}, {
  stablecoinId: "stbt-matrixdock",
  reason: "2026-10-06 attempt 1791312367 received HTTP 403 on both official JSON hosts. The configured adapter is weak-live-probe, outside review eligibility.",
  sources: ["https://www.matrixdock.com/bond/anon/website/api/v1/stats", "https://app.matrixdock.com/bond/anon/website/api/v1/stats"],
}] as const;

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

export async function matchReserveFeedReview(
  db: D1Database,
  state: ReserveSyncStateRecord | null,
  now: number,
  reviewsById = resolveReserveFeedReviews(now).activeById,
): Promise<ReserveFeedReview | null> {
  if (!state || state.metadata.uncertainWrite === true) return null;
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
  if (review.errorPrefix != null && !failure.lastError?.startsWith(review.errorPrefix)) return null;
  return review;
}
