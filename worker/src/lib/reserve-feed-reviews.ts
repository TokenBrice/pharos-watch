import { ReserveFeedReviewSchema, type ReserveFeedReview } from "@shared/types/live-reserves";
import { RESERVE_FEED_REVIEW_MAX_AGE_SEC } from "@shared/lib/status-thresholds";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { getConfiguredLiveReserveCoins, type ReserveSyncStateRecord } from "./live-reserves/store-shared";
import { loadLatestNonSkippedReserveAttempt, type ReserveSyncAttemptTimelineEntry } from "./live-reserves/store-history-read";

const reviewedAt = Date.UTC(2026, 9, 7, 14, 19, 23) / 1000;
const expiresAt = reviewedAt + RESERVE_FEED_REVIEW_MAX_AGE_SEC;

/** Dated operational acknowledgements: no snapshot, scoring, or freshness authority. */
export const RESERVE_FEED_REVIEWS: readonly ReserveFeedReview[] = [
  {
    stablecoinId: "gusd-gemini", adapterKey: "gemini-independent-assurance", failureCategory: "unknown",
    warningCodes: [], errorPrefix: "primary:http-json: gemini-independent-assurance: newer unreviewed report on official index",
    owner: "ops", reason: "2026-10-07 official Contentful index still leads with the July 31 report, marked draft as of October 2, newer than the pinned May report. The same unreviewed-report failure persists; this acknowledges pending report review without admitting the draft or changing freshness.",
    sources: [
      { url: "https://www.gemini.com/dollar", evidenceDate: "2026-10-07" },
      { url: "https://assets.ctfassets.net/jg6lo9a2ukvr/1fSg98ekn9sHoyC1SnjceC/eca615fb0dfcaf8f3cd1541fc4c1c0bd/Gemini-GUSD_Reserves_Report_-July_2026.pdf", evidenceDate: "2026-10-02" },
    ], reviewedAt, expiresAt,
  },
  {
    stablecoinId: "mtbill-midas", adapterKey: "midas-mtbill", failureCategory: "unknown",
    warningCodes: [], errorPrefix: "primary:onchain-evm: midas-mtbill:save-rounded-totals-mismatch",
    owner: "ops", reason: "2026-10-19 SAVE registry checkpoint at 10:00 UTC and its historical issuer book agree on $78,625,877.4271, but the historical display total is $78,627,000: a $1,122.5729 mismatch beyond the unchanged $1,000 bound. The current failure is upstream report inconsistency, not the separately stale September 18 latest endpoint. Keep the snapshot quarantined pending issuer correction; no freshness, reconciliation, or scoring exception is granted.",
    sources: [
      { url: "https://etherscan.io/address/0x2d6e9f608807436de5d9603b00abe3fed1bc809d", evidenceDate: "2026-10-19" },
      { url: "https://gateway.pinata.cloud/ipfs/QmR98wvJxfE6Sj6EsgQs2ZzaVomRccmDrLcBXoFCYHn8ok", evidenceDate: "2026-10-19" },
      { url: "https://api-prod.midas.app/api/transparency/by-timestamp?token=mTBILL&timestamp=2026-10-19T10%3A00", evidenceDate: "2026-10-19" },
    ],
    reviewedAt: Date.UTC(2026, 9, 19, 18, 48, 40) / 1000,
    expiresAt: Date.UTC(2026, 9, 26, 18, 48, 40) / 1000,
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
