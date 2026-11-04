import { ReserveFeedReviewSchema, type ReserveFeedReview } from "@shared/types/live-reserves";
import { RESERVE_FEED_REVIEW_MAX_AGE_SEC } from "@shared/lib/status-thresholds";
import { getLiveReserveAdapterDefinition, getLiveReserveAdapterValidationPolicy } from "@shared/lib/live-reserve-adapters";
import { resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { getConfiguredLiveReserveCoins, LIVE_RESERVE_FRESHNESS_SEC, type ReserveSyncStateRecord } from "./live-reserves/store-shared";
import { loadLatestNonSkippedReserveAttempt, type ReserveSyncAttemptTimelineEntry } from "./live-reserves/store-history-read";
import { hasScoringEligibleLiveReserveFreshness } from "./live-reserves/store-snapshot-state";

/** Dated operational acknowledgements: no snapshot, scoring, or freshness authority. */
export const RESERVE_FEED_REVIEWS: readonly ReserveFeedReview[] = [
  {
    stablecoinId: "yzusd-yuzu", adapterKey: "accountable", failureCategory: "unknown",
    warningCodes: [], errorPrefix: "primary:http-json: Accountable exposure_split has no contemporaneous timeline reserve total for reconciliation",
    owner: "ops", reason: "GET observed 2026-11-04T08:24:37Z (dashboard envelope ts 2026-11-04T07:46:08.953Z): exposure_split_ts is 2026-11-03T13:00:10Z, but the dated `reserves.timeline` rows for November 1, 2 and 3 repeat ts 1793490451779 (2026-10-31T23:47:31.779Z) with reserves $62,957,212.36. The November 4 row repeats the live envelope clock and is not a reconciliation anchor. The nearest non-live bracket is 220,359 seconds (2.55 days) behind the split, beyond the unchanged 24-hour window, with no later non-live bracket, so the attempt fails closed. The split's 21 leaf values total $50,183,467.09, versus live total_reserves $48,429,377.61 (+$1,754,089.48, 3.62%, also outside the unchanged 1% bound); timeline repair alone does not establish reconciliation. The live envelope is $14,527,834.75 (23.08%) below the repeated $62.96M total; Accountable reports yzUSD supply $42,722,587.88, while the November 4 Pharos stablecoins capture reports $42,669,309.82 from DefiLlama. These different clocks and scopes establish neither a loss nor a fresh reconciled composition. Keep failed evidence quarantined and original clocks unchanged pending issuer repair; this acknowledgement covers only the exact stale-timeline category and error text, with no reconciliation, freshness or scoring exception. A bucket-total, invalid-value or transport failure remains unacknowledged.",
    sources: [{ url: "https://cache.accountable.capital/dashboard/yuzu", evidenceDate: "2026-11-04" }],
    reviewedAt: Date.UTC(2026, 10, 4, 8, 24, 37) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 8, 24, 37) / 1000,
  },
  {
    stablecoinId: "nwisdom-nest", adapterKey: "nest-vault-positions", failureCategory: null,
    warningCodes: ["stale-source-data"], errorPrefix: null, sourceTimestamp: 1793302678,
    owner: "ops", reason: "Keyless issuer GETs observed 2026-11-04T09:02:39Z (positions and last-price-update), with price at 09:02:40Z: latest accountant updatedAt remains 1793302678 (2026-10-29T19:37:58Z). Settled positions total $15,749.82659297394, including $15,707.79 unidentified nUSDR (99.7331%); the production projection read at 09:03:20Z retains unknownExposurePct 99.73310925836635 and stale-source-data. This dated review acknowledges that exact stalled clock and degraded warning set, not nUSDR identity, holdings quality or fresh backing. Keep stale evidence quarantined, original clocks and scoring refusal unchanged; clock advancement or any different warning/cause requires a new assessment.",
    sources: [
      { url: "https://api.nest.credit/v1/vaults/nest-wisdom-vault/positions", evidenceDate: "2026-11-04" },
      { url: "https://api.nest.credit/v1/vaults/nest-wisdom-vault/last-price-update", evidenceDate: "2026-11-04" },
      { url: "https://pharos.watch/_site-data/stablecoin-reserves/nwisdom-nest", evidenceDate: "2026-11-04" },
    ],
    reviewedAt: Date.UTC(2026, 10, 4, 9, 4, 8) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 9, 4, 8) / 1000,
  },
  {
    stablecoinId: "zsd-zephyr-protocol", adapterKey: "zephyr-scanner", failureCategory: null,
    warningCodes: ["stale-source-data"], errorPrefix: null, sourceTimestamp: 1792250105,
    owner: "ops", reason: "Issuer reservesnapshots GET observed 2026-11-04T09:02:40Z still returns height 887405, capturedAt 2026-10-17T15:17:42.772Z and material pricing timestamp 1792250105 (2026-10-17T15:15:05Z). Production projection rechecked 09:03:21Z retains stale-source-data and the original clock. Acknowledge only this frozen scanner/clock and exact warning set; no timestamp-free livestats substitution or freshness/scoring exception. If still frozen, the feed qualifies for retirement on 2026-11-16 under owner decision D6; this seven-day review expires first and requires fresh evidence to renew.",
    sources: [
      { url: "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc", evidenceDate: "2026-11-04" },
      { url: "https://pharos.watch/_site-data/stablecoin-reserves/zsd-zephyr-protocol", evidenceDate: "2026-11-04" },
    ],
    reviewedAt: Date.UTC(2026, 10, 4, 9, 4, 8) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 9, 4, 8) / 1000,
  },
  {
    stablecoinId: "zys-zephyr-protocol", adapterKey: "zephyr-scanner", failureCategory: null,
    warningCodes: ["stale-source-data"], errorPrefix: null, sourceTimestamp: 1792250105,
    owner: "ops", reason: "Issuer reservesnapshots GET observed 2026-11-04T09:02:40Z still returns the underlying ZSD reserve height 887405, capturedAt 2026-10-17T15:17:42.772Z and material pricing clock 2026-10-17T15:15:05Z. ZYS production projection rechecked 09:03:22Z retains that clock and stale-source-data. Acknowledge only the frozen underlying scanner/clock and exact warning set; wrapper share NAV cannot establish fresh underlying backing. Raw evidence remains quarantined with unchanged clocks and scoring refusal. If still frozen, retirement qualifies on 2026-11-16 (D6); renew this earlier-expiring review only against fresh evidence.",
    sources: [
      { url: "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc", evidenceDate: "2026-11-04" },
      { url: "https://pharos.watch/_site-data/stablecoin-reserves/zys-zephyr-protocol", evidenceDate: "2026-11-04" },
    ],
    reviewedAt: Date.UTC(2026, 10, 4, 9, 4, 8) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 9, 4, 8) / 1000,
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
    owner: "ops", reason: "Keyless issuer historical-portfolio GET observed 2026-11-04T09:04:08Z at the production checkpoint query token=mTBILL&timestamp=2026-11-03T14%3A00 returned HTTP 403, cf-mitigated: challenge (CF-RAY a55273140eb11778-BEG; body SHA256 e2a9bdf8098311cb99023323f057571445e79165ce565eba7d66bcf4f8e626be). The 09:03:22Z production projection records upstream-http and midas-mtbill:source-egress-blocked: HTTP 403 for the same endpoint. Acknowledge only that stable HTTP-403 class, adapter and empty warning set, allowing the historical timestamp query to vary. Other HTTP status/cause/endpoint or new warnings remain unacknowledged; failed evidence stays quarantined, with no composition, clock or scoring exception.",
    sources: [
      { url: "https://api-prod.midas.app/api/transparency/by-timestamp?token=mTBILL&timestamp=2026-11-03T14%3A00", evidenceDate: "2026-11-04" },
      { url: "https://pharos.watch/_site-data/stablecoin-reserves/mtbill-midas", evidenceDate: "2026-11-04" },
    ],
    reviewedAt: Date.UTC(2026, 10, 4, 9, 4, 8) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 9, 4, 8) / 1000,
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
