import { LIVE_RESERVE_FRESHNESS_SEC } from "./live-reserve-policy";
import { ReserveFeedReviewSchema, type ReserveFeedReview } from "@shared/types/live-reserves";
import { RESERVE_FEED_REVIEW_MAX_AGE_SEC } from "@shared/lib/status-thresholds";
import { getLiveReserveAdapterDefinition, getLiveReserveAdapterValidationPolicy } from "@shared/lib/live-reserve-adapters";
import { resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { getConfiguredLiveReserveCoins, type ReserveSyncStateRecord } from "./live-reserves/store-shared";
import { loadLatestNonSkippedReserveAttempt, type ReserveSyncAttemptTimelineEntry } from "./live-reserves/store-history-read";
import { hasScoringEligibleLiveReserveFreshness } from "./live-reserves/store-snapshot-state";

/** Dated operational acknowledgements: no snapshot, scoring, or freshness authority. */
export const RESERVE_FEED_REVIEWS: readonly ReserveFeedReview[] = [
  {
    stablecoinId: "yzusd-yuzu", adapterKey: "accountable", failureCategory: "unknown",
    warningCodes: [], errorPrefix: "primary:http-json: Accountable exposure_split has no contemporaneous timeline reserve total for reconciliation",
    owner: "ops", reason: "Issuer GET rechecked 2026-11-07T19:43:38Z: exposure_split_ts remains 2026-11-03T13:00:10Z. November 1-4 timeline rows repeat 1793490451779 (October 31); the nearest non-live bracket is now November 5 at 1793922368335, still 211,558 seconds (2.45 days) after the split and outside the unchanged 24-hour window. The November 7 row repeats the live envelope clock 1794079871779 and cannot date the split. Its 22 leaves total $50,183,467.12 versus current total_reserves $48,206,074.05 (+4.10%); timeline repair alone does not establish the unchanged 1% reconciliation. Latest production attempt still reports this exact error/category with no warnings. Renew only that stale-timeline finding for seven days; preserve original clocks, quarantine and scoring refusal. Different errors, warnings or categories remain unacknowledged.",
    sources: [{ url: "https://cache.accountable.capital/dashboard/yuzu", evidenceDate: "2026-11-07" }],
    reviewedAt: Date.UTC(2026, 10, 7, 19, 46, 52) / 1000,
    expiresAt: Date.UTC(2026, 10, 14, 19, 46, 52) / 1000,
  },
  {
    stablecoinId: "nwisdom-nest", adapterKey: "nest-vault-positions", failureCategory: null,
    warningCodes: ["stale-source-data"], errorPrefix: null, sourceTimestamp: 1793302678,
    owner: "ops", reason: "Issuer positions, price and last-price-update GETs rechecked 2026-11-07: latest accountant updatedAt remains 1793302678 (2026-10-29T19:37:58Z), about nine days old. Settled positions remain $15,749.82659297394, including $15,707.79 unidentified nUSDR (99.7331%); reported NAV is $15,749.819224982213. Renew only the exact stalled clock and stale-source-data warning for seven days, not nUSDR identity or fresh backing. Preserve original clocks, quarantine and scoring refusal; clock advancement or a different warning/cause requires reassessment.",
    sources: [
      { url: "https://api.nest.credit/v1/vaults/nest-wisdom-vault/positions", evidenceDate: "2026-11-07" },
      { url: "https://api.nest.credit/v1/vaults/nest-wisdom-vault/last-price-update", evidenceDate: "2026-11-07" },
      { url: "https://api.nest.credit/v1/vaults/nest-wisdom-vault/price", evidenceDate: "2026-11-07" },
    ],
    reviewedAt: Date.UTC(2026, 10, 7, 19, 46, 52) / 1000,
    expiresAt: Date.UTC(2026, 10, 14, 19, 46, 52) / 1000,
  },
  {
    stablecoinId: "zsd-zephyr-protocol", adapterKey: "zephyr-scanner", failureCategory: null,
    warningCodes: ["stale-source-data"], errorPrefix: null, sourceTimestamp: 1792250105,
    owner: "ops", reason: "Issuer reservesnapshots GET rechecked 2026-11-07 still returns height 887405, captured_at 2026-10-17T15:17:42.772Z and pricing timestamp 1792250105 (2026-10-17T15:15:05Z), about 21 days old. Production cohort retains the same stalled clock and stale-source-data warning. Renew only that exact scanner/clock and warning set for seven days; no timestamp-free livestats substitution or freshness/scoring exception. D6 retirement remains 2026-11-16 if still frozen; this review expires first and cannot authorize early retirement.",
    sources: [
      { url: "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc", evidenceDate: "2026-11-07" },
    ],
    reviewedAt: Date.UTC(2026, 10, 7, 19, 46, 52) / 1000,
    expiresAt: Date.UTC(2026, 10, 14, 19, 46, 52) / 1000,
  },
  {
    stablecoinId: "zys-zephyr-protocol", adapterKey: "zephyr-scanner", failureCategory: null,
    warningCodes: ["stale-source-data"], errorPrefix: null, sourceTimestamp: 1792250105,
    owner: "ops", reason: "Issuer reservesnapshots GET rechecked 2026-11-07 still returns underlying ZSD reserve height 887405, captured_at 2026-10-17T15:17:42.772Z and pricing timestamp 1792250105 (2026-10-17T15:15:05Z), about 21 days old. Production cohort retains that stalled clock and stale-source-data warning. Renew only the frozen underlying scanner/clock and exact warning set for seven days; wrapper NAV cannot establish fresh underlying backing. Preserve original clocks, quarantine and scoring refusal. D6 retirement remains 2026-11-16 if still frozen; this review expires first and cannot authorize early retirement.",
    sources: [
      { url: "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc", evidenceDate: "2026-11-07" },
    ],
    reviewedAt: Date.UTC(2026, 10, 7, 19, 46, 52) / 1000,
    expiresAt: Date.UTC(2026, 10, 14, 19, 46, 52) / 1000,
  },
  {
    stablecoinId: "m-m0", adapterKey: "m0", failureCategory: null,
    warningCodes: ["minter-collateral-reconciliation"], errorPrefix: null,
    owner: "ops", reason: "Keyless production reserve projection GET observed 2026-11-04T09:03:22Z: sourceTimestamp 1793778131 (07:42:11Z), attempt 1793779933 (08:12:13Z), global collateral $220,896,523.037063 versus four-minter sum $193,515,313.204742, a $27,381,209.832321 discrepancy (12.39549%, rounded 12.40%). This is production evidence, not an independent upstream replay: the configured M0 GraphQL API requires Wrangler-managed M0_API_KEY and was not called. Acknowledge only the null-category degraded minter-collateral-reconciliation finding; keep the reconciliation guard, raw evidence quarantine, source clocks and scoring refusal. No discrepancy value is accepted as reconciled backing and no fallback/source admission changes.",
    sources: [{ url: "https://pharos.watch/_site-data/stablecoin-reserves/m-m0", evidenceDate: "2026-11-04" }],
    reviewedAt: Date.UTC(2026, 10, 4, 9, 4, 8) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 9, 4, 8) / 1000,
  },
  {
    stablecoinId: "mtbill-midas", adapterKey: "midas-mtbill", failureCategory: "upstream-http",
    warningCodes: [], errorPrefix: null, errorClass: "http-403",
    owner: "ops", reason: "Issuer historical-portfolio GET rechecked 2026-11-07T19:43:37Z for the latest production checkpoint query token=mTBILL&timestamp=2026-11-06T12%3A00 still returns HTTP 403 from Cloudflare (CF-RAY a56ed3f16b01e292-BEG; two-byte JSON body SHA256 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a). Latest production attempt reports upstream-http/source-egress-blocked for the same endpoint with no warnings; 40 seven-day attempts are the same HTTP-403 failure. Last success was October 24, so the outage remains below the 30-day retirement boundary. Renew only this stable HTTP-403 class, adapter, endpoint and empty warning set for seven days, allowing the checkpoint query to vary. Other causes/statuses/warnings remain unacknowledged; preserve quarantine, original clocks and scoring refusal. An issuer-approved reachable historical source requires separate evidence and allowlist review.",
    sources: [
      { url: "https://api-prod.midas.app/api/transparency/by-timestamp?token=mTBILL&timestamp=2026-11-06T12%3A00", evidenceDate: "2026-11-07" },
    ],
    reviewedAt: Date.UTC(2026, 10, 7, 19, 46, 52) / 1000,
    expiresAt: Date.UTC(2026, 10, 14, 19, 46, 52) / 1000,
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
      || (evidenceClass !== "independent" && evidenceClass !== "static-validated"
        && !(evidenceClass === "weak-live-probe" && review.sourceTimestamp != null))
      || !validDates || review.reviewedAt > now || review.expiresAt <= review.reviewedAt
      || review.expiresAt - review.reviewedAt > RESERVE_FEED_REVIEW_MAX_AGE_SEC) {
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
 * Dated acknowledgements match the adapter, category, complete warning set and
 * exact error, configured-endpoint HTTP class or original stalled clock.
 * Unreadable evidence and circuit history never suppress an alert.
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
  if (state.warningIntegrityIssue || state.warningCount !== state.warnings.length
    || state.warnings.some((warning) => warning.effect === "fatal")) return null;
  const review = reviewsById.get(state.stablecoinId);
  if (!review || review.adapterKey !== state.adapterKey || now < review.reviewedAt || now >= review.expiresAt) return null;
  if (state.metadata.failureCategory != null && typeof state.metadata.failureCategory !== "string") return null;
  let failure: Pick<ReserveSyncAttemptTimelineEntry, "adapterKey" | "status" | "failureCategory" | "warningCodes" | "lastError"> = {
    adapterKey: state.adapterKey, status: state.lastStatus,
    failureCategory: typeof state.metadata.failureCategory === "string" ? state.metadata.failureCategory : null,
    warningCodes: state.warnings.map((warning) => warning.code), lastError: state.lastError,
  };
  if (state.lastStatus === "skipped" && state.metadata.failureCategory === "circuit-open") {
    if (review.failureCategory === null) return null;
    try {
      const prior = await loadLatestNonSkippedReserveAttempt(db, state.stablecoinId);
      if (!prior) return null;
      failure = prior;
    } catch { return null; }
  }
  if (failure.status !== "error" && failure.status !== "degraded"
    && !(review.sourceTimestamp != null && failure.status === "ok")) return null;
  if (failure.status === "ok" && state.warnings.some((warning) => warning.effect === "degraded")) return null;
  if (failure.failureCategory === "adapter-timeout" || failure.failureCategory === "run-budget-exhausted"
    || failure.lastError?.includes("future-portfolio-timestamp")) return null;
  if (failure.adapterKey !== review.adapterKey || failure.failureCategory !== review.failureCategory) return null;
  // Exact warning set prevents a new fatal condition inheriting an old review.
  if (failure.warningCodes.length !== review.warningCodes.length
    || failure.warningCodes.some((code) => !review.warningCodes.includes(code))) return null;
  if (review.failureCategory === null && (failure.status === "error" || failure.lastError !== null
    || state.lastAttemptedAt == null || state.lastSuccessAt !== state.lastAttemptedAt
    || !hasScoringEligibleLiveReserveFreshness(state.metadata, now))) return null;
  if (review.failureCategory === null && review.sourceTimestamp == null
    && !state.warnings.some((warning) => warning.effect === "degraded")) return null;
  const config = getConfiguredLiveReserveCoins().find((coin) => coin.id === state.stablecoinId)?.liveReservesConfig;
  if (review.sourceTimestamp != null) {
    const budget = config && resolveLiveReserveSourceAgeBudget(config.scoring?.maxSourceAgeSec,
      getLiveReserveAdapterValidationPolicy(config.adapter)?.maxSourceAgeSec, LIVE_RESERVE_FRESHNESS_SEC).sourceAgeBudgetSec;
    if (state.metadata.freshnessMode !== "verified" || state.metadata.sourceTimestamp !== review.sourceTimestamp
      || budget == null || now - review.sourceTimestamp <= budget) return null;
  }
  if (review.errorClass != null) {
    // Only the single primary failure may inherit a class; mixed fallback causes remain unreviewed.
    const message = review.adapterKey === "midas-mtbill"
      ? failure.lastError?.replace("primary:onchain-evm: midas-mtbill:source-egress-blocked: ", "primary:onchain-evm: ")
      : failure.lastError;
    const http = /^primary:(http-json|http-html|onchain-evm): HTTP ([45]\d{2}) for (https:\/\/\S+)$/.exec(message ?? "");
    if (!config || !http || http[1] !== config.inputs.primary.kind || `http-${http[2]}` !== review.errorClass) return null;
    const endpoint = "url" in config.inputs.primary ? config.inputs.primary.url : config.params?.historicalSourceUrl;
    if (typeof endpoint !== "string") return null;
    try {
      const expected = new URL(endpoint);
      const observed = new URL(http[3]);
      if (observed.origin !== expected.origin || observed.pathname !== expected.pathname
        || observed.username || observed.password || observed.hash) return null;
    } catch { return null; }
  } else if (failure.lastError !== review.errorPrefix) return null;
  return review;
}
