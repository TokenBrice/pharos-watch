import { hasCurrentPendingClosureVerdict, type PendingDepegRow } from "./depeg-pending";
import { CANARY_METADATA_BUDGET } from "./canary-check-results";
import {
  DEX_FRESHNESS_SEC,
  DEX_PROTOCOL_SOURCE_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
} from "@shared/lib/depeg-config";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PSI_ELIGIBLE_META_BY_ID, PSI_HISTORICAL_IDS } from "@shared/lib/psi-eligible";
import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { STATUS_DEPEG_DETECTION_THRESHOLDS } from "@shared/lib/status-thresholds";
import { getReferenceMarket, getReferenceMarketClosureStart, isMetalMarketClosed, type ReferenceMarket } from "@shared/lib/reference-market-hours";
import { toErrorMessage } from "@shared/lib/error-utils";
import { z } from "zod";
import {
  getDepegRecoveryThresholdBps,
  getDepegThresholdBps,
} from "./depeg-threshold-policy";
import {
  collectDexProtocolCorroborations,
  isExtremeMovePending,
  type DexPoolSource,
} from "./depeg-helpers";
import {
  DDR_REPAIR_TASK_ACTIVE_STATE_SQL,
  DDR_REPAIR_TASK_KIND,
} from "./repair-tasks";
import {
  freshDepegDeadBandNotices,
  DEPEG_CENSUS_PRODUCER_JOB,
  loadDepegCensusRuns,
} from "./depeg-ledger-clock";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { getDexPriceSourceEntries } from "./depeg-trust-policy";
import type { DepegObservationCensus } from "../cron/depeg-detection/types";
import { resolveStablecoinMarketHours, resolveStablecoinPriceGapReviews } from "./stablecoin-publication-coverage";
import { PSI_HISTORICAL_PRICE_GAP_REVIEWS, STABLECOIN_PRICE_GAP_REVIEWS, type StablecoinPriceGapReview } from "./stablecoin-publication-reviews";

type DepegCanaryFinding = {
  status: "ok" | "degraded" | "error";
  severity: "info" | "warning" | "error";
  executionStatus: "completed" | "failed";
  executionFailureReason: string | null;
  error?: string;
  metadata?: Record<string, unknown>;
};

function okFinding(metadata?: Record<string, unknown>): DepegCanaryFinding {
  return { status: "ok", severity: "info", executionStatus: "completed", executionFailureReason: null, metadata };
}

function degradedFinding(error: string, metadata?: Record<string, unknown>): DepegCanaryFinding {
  return { status: "degraded", severity: "warning", executionStatus: "completed", executionFailureReason: null, error, metadata };
}

function errorFinding(error: string, metadata?: Record<string, unknown>): DepegCanaryFinding {
  return { status: "error", severity: "error", executionStatus: "completed", executionFailureReason: null, error, metadata };
}

function failedFinding(reason: string, metadata?: Record<string, unknown>): DepegCanaryFinding {
  return {
    status: "error",
    severity: "error",
    executionStatus: "failed",
    executionFailureReason: reason,
    error: reason,
    metadata,
  };
}

/** Our own read failed: report the measurement as failed, never as a healthy or broken producer. */
function unavailableFinding(error: unknown): DepegCanaryFinding {
  const message = toErrorMessage(error);
  return failedFinding("canary-source-unavailable", { error: message.length <= 800 ? message : `${message.slice(0, 800)}...` });
}

/** Closure start per asset a closed reference market holds at `observedAt`, or held until less than `graceSec` before it. */
function referenceMarketHeld(observedAt: number, graceSec: number): Map<string, number> {
  const since = (market: ReferenceMarket) =>
    getReferenceMarketClosureStart(market, observedAt) ?? getReferenceMarketClosureStart(market, observedAt - graceSec);
  const byMarket = { metal: since("metal"), fx: since("fx") };
  const held = new Map<string, number>();
  for (const meta of PSI_ELIGIBLE_META_BY_ID.values()) {
    const market = getReferenceMarket(meta.flags.pegCurrency);
    const start = market == null ? null : byMarket[market];
    if (start != null) held.set(meta.id, start);
  }
  return held;
}

function unavailableShare(census: { eligibleCount: number; unavailableCount: number }): number | null {
  return census.eligibleCount > 0 ? census.unavailableCount / census.eligibleCount : null;
}

const NO_PARITY_QUOTE_REVIEW_MAX_AGE_SEC = 7 * 86_400;
export const DEPEG_NO_PARITY_QUOTE_REVIEWS: readonly StablecoinPriceGapReview[] = [
  {
    stablecoinId: "susd-solayer",
    owner: "ops",
    reason: "Re-reviewed 2026-11-25 10:33 UTC: Solayer sUSD publishes an upstream-clocked protocol-redeem valuation of accrued USD per raw token ($1.1814, priceObservedAt 2026-11-25T10:32:20Z, high confidence) and depeg-detection-census (evaluated 2026-11-25T10:17:33Z) acknowledges susd-solayer under noParityQuoteByDesign (observedNonParityProtocolRedeem: true). The selected mark supplies no accrued-token market parity quote. Solayer announced sUSD wind-down on 2026-07-22 with self-serve withdrawal ending 2026-12-31; owner ops tracks the separate lifecycle/sunset decision, unchanged by this 7-day source review.",
    sources: [
      "https://api.pharos.watch/api/stablecoins",
      "https://x.com/solayer_labs/status/2080010441087222114",
    ],
    reviewedAt: Date.UTC(2026, 10, 25, 10, 33) / 1000,
    expiresAt: Date.UTC(2026, 11, 2, 10, 33) / 1000,
  },
];

/** Operator completeness only: source facts never acknowledge detection or event blindness. */
export function assessDepegObservationGaps(census: DepegObservationCensus, observedAt: number) {
  const acknowledgedUnavailableIds = {
    reviewedNominalReference: [] as string[],
    scheduledMarketClosure: [] as string[],
    reviewedPriceGap: [] as string[],
    noParityQuoteByDesign: [] as string[],
  };
  // A reference-market closure holds FX and metal pegs by schedule (metal hours contain FX hours):
  // acknowledged by count, and only
  // when the census clock is inside a closure, so an off-schedule hold stays actionable.
  const marketClosedCount = isMetalMarketClosed(census.evaluatedAt)
    ? census.reasonCounts["reference-market-closed"] ?? 0
    : 0;
  const reasonCounts: DepegObservationCensus["reasonCounts"] = { ...census.reasonCounts };
  if (marketClosedCount > 0) delete reasonCounts["reference-market-closed"];
  // Identities exist only for primary-unusable gaps; a census without any has nothing to acknowledge.
  const primaryUnusableCount = census.reasonCounts["primary-unusable"] ?? 0;
  const assets = census.unavailableAssets ?? (primaryUnusableCount === 0 ? [] : undefined);
  const unavailableIdsComplete = census.unavailableIdsTruncated !== true && !census.unavailableIdsDropped
    && assets != null && assets.length === primaryUnusableCount
    && assets.every((asset) => asset.reason === "primary-unusable")
    && new Set(assets.map((asset) => asset.id)).size === assets.length;
  if (!unavailableIdsComplete) {
    return { unavailableIdsComplete: false, acknowledgedUnavailableCount: marketClosedCount,
      actionableUnavailableCount: census.unavailableCount - marketClosedCount, acknowledgedUnavailableIds,
      actionableUnavailableIds: null, actionableReasonCounts: reasonCounts };
  }
  const ids = assets.map((asset) => asset.id);
  const marketHours = resolveStablecoinMarketHours(ids, census.evaluatedAt);
  const reviews = resolveStablecoinPriceGapReviews(ids, observedAt, [
    ...STABLECOIN_PRICE_GAP_REVIEWS.filter((review) => ACTIVE_IDS.has(review.stablecoinId)),
    ...PSI_HISTORICAL_PRICE_GAP_REVIEWS.filter((review) => PSI_HISTORICAL_IDS.has(review.stablecoinId)),
  ]);
  const noParityQuoteReviews = resolveStablecoinPriceGapReviews(ids, observedAt, DEPEG_NO_PARITY_QUOTE_REVIEWS.filter(
    (review) => review.expiresAt - review.reviewedAt <= NO_PARITY_QUOTE_REVIEW_MAX_AGE_SEC,
  ));
  const actionableUnavailableIds: string[] = [];
  for (const asset of assets) {
    if (asset.reason === "primary-unusable") {
      if (asset.reviewedNominalReference) {
        acknowledgedUnavailableIds.reviewedNominalReference.push(asset.id);
        continue;
      }
      if (marketHours.alertSuppressedIds.has(asset.id)) {
        acknowledgedUnavailableIds.scheduledMarketClosure.push(asset.id);
        continue;
      }
      if (reviews.activeById.has(asset.id)) {
        acknowledgedUnavailableIds.reviewedPriceGap.push(asset.id);
        continue;
      }
      if (asset.observedNonParityProtocolRedeem === true && noParityQuoteReviews.activeById.has(asset.id)) {
        acknowledgedUnavailableIds.noParityQuoteByDesign.push(asset.id);
        continue;
      }
    }
    actionableUnavailableIds.push(asset.id);
  }
  const acknowledgedIdCount = Object.values(acknowledgedUnavailableIds).reduce((sum, list) => sum + list.length, 0);
  const actionableReasonCounts = reasonCounts;
  if (primaryUnusableCount > acknowledgedIdCount) {
    actionableReasonCounts["primary-unusable"] = primaryUnusableCount - acknowledgedIdCount;
  } else {
    delete actionableReasonCounts["primary-unusable"];
  }
  const acknowledgedUnavailableCount = acknowledgedIdCount + marketClosedCount;
  return { unavailableIdsComplete, acknowledgedUnavailableIds, actionableUnavailableIds, actionableReasonCounts,
    acknowledgedUnavailableCount, actionableUnavailableCount: census.unavailableCount - acknowledgedUnavailableCount };
}

/**
 * The detection census is computed per run and stamped with
 * `capabilities.depegPipeline`; a run that evaluates almost no assets is
 * otherwise indistinguishable from a healthy one. Two consecutive censuses
 * above the unavailable share degrade, so one noisy run is not a finding.
 */
export async function checkDepegDetectionCensus(db: D1Database, observedAt: number) {
  try {
    const runs = await loadDepegCensusRuns(db);
    const maxAgeSec = CRON_INTERVALS[DEPEG_CENSUS_PRODUCER_JOB] * STATUS_DEPEG_DETECTION_THRESHOLDS.ledgerMaxAgeIntervals;
    if (runs.length === 0) {
      return failedFinding("depeg-census-source-missing", { producerJob: DEPEG_CENSUS_PRODUCER_JOB, maxAgeSec });
    }
    const latest = runs.find((run) => run.pipelineSucceeded);
    if (latest?.census == null) {
      const run = latest ?? runs[0];
      const metadata = {
        producerJob: DEPEG_CENSUS_PRODUCER_JOB,
        latestRunAt: run.runStartedAt,
        unavailableReason: run.unavailableReason,
        maxAgeSec,
      };
      return latest ? failedFinding("depeg-census-invalid", metadata) : degradedFinding("depeg-census-missing", metadata);
    }
    const prior = runs.find((run) => run.pipelineSucceeded && run.runStartedAt < latest.runStartedAt);
    const census = latest.census;
    const ageSec = Math.max(0, observedAt - latest.runStartedAt);
    const share = unavailableShare(census);
    const priorShare = prior?.census == null ? null : unavailableShare(prior.census);
    const gaps = assessDepegObservationGaps(census, observedAt);
    const priorGaps = prior?.census == null ? null : assessDepegObservationGaps(prior.census, observedAt);
    const actionableShare = unavailableShare({ eligibleCount: census.eligibleCount, unavailableCount: gaps.actionableUnavailableCount });
    const priorActionableShare = prior?.census == null || priorGaps == null ? null
      : unavailableShare({ eligibleCount: prior.census.eligibleCount, unavailableCount: priorGaps.actionableUnavailableCount });
    const metadata = {
      producerJob: DEPEG_CENSUS_PRODUCER_JOB,
      runStartedAt: latest.runStartedAt,
      censusEvaluatedAt: census.evaluatedAt,
      ageSec,
      maxAgeSec,
      eligibleCount: census.eligibleCount,
      observedCount: census.observedCount,
      unavailableCount: census.unavailableCount,
      belowFloorCount: census.belowFloorCount,
      reasonCounts: census.reasonCounts,
      unavailableShare: share,
      priorUnavailableShare: priorShare,
      ...gaps,
      actionableUnavailableShare: actionableShare,
      priorActionableUnavailableShare: priorActionableShare,
      priorRunStartedAt: prior?.runStartedAt ?? null,
    };
    if (ageSec > maxAgeSec) {
      return degradedFinding(`depeg detection census is ${ageSec}s old`, metadata);
    }
    if (
      actionableShare != null && priorActionableShare != null
      && actionableShare > STATUS_DEPEG_DETECTION_THRESHOLDS.unavailableShareMax
      && priorActionableShare > STATUS_DEPEG_DETECTION_THRESHOLDS.unavailableShareMax
    ) {
      return degradedFinding(
        `depeg observation actionable unavailable for ${gaps.actionableUnavailableCount}/${census.eligibleCount} eligible assets in two consecutive runs`,
        metadata,
      );
    }
    return okFinding(metadata);
  } catch (error) {
    return unavailableFinding(error);
  }
}

interface PendingConfirmationSummaryRow {
  severe_recent: number | null;
}

/**
 * Pending candidates are deleted with an outcome and never create a
 * `depeg_events` row, so an expired extreme move or a row that outlives the
 * dynamic expiry limit for its reason is the only evidence that the
 * confirmation stage stopped promoting. Base-window counts stay metadata: a
 * candidate may legitimately wait for the extended or severe limit.
 */
export async function checkDepegPendingConfirmation(db: D1Database, observedAt: number) {
  try {
    const baseExpirySec = STATUS_DEPEG_DETECTION_THRESHOLDS.pendingBaseMaxAgeSec;
    const extendedExpirySec = STATUS_DEPEG_DETECTION_THRESHOLDS.pendingExtendedMaxAgeSec;
    const severeExpirySec = STATUS_DEPEG_DETECTION_THRESHOLDS.pendingSevereMaxAgeSec;
    const stalledGraceSec =
      CRON_INTERVALS["sync-stablecoins"] * STATUS_DEPEG_DETECTION_THRESHOLDS.pendingStalledGraceIntervals;
    const summary = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* pharos:depeg-pending-confirmation-canary */
             (SELECT COUNT(*) FROM depeg_pending_outcomes
               WHERE outcome = 'unconfirmed-severe' AND outcome_at >= ?) AS severe_recent`,
        )
        .bind(observedAt - STATUS_DEPEG_DETECTION_THRESHOLDS.unconfirmedSevereLookbackSec)
        .first<PendingConfirmationSummaryRow>(),
    );
    if (!summary || !Number.isInteger(summary.severe_recent)) {
      return failedFinding("depeg-pending-aggregate-unavailable");
    }
    const pending = await loadPendingCandidates(db);
    const olderThanBase = pending.filter((row) => row.first_seen_at <= observedAt - baseExpirySec);
    const held = referenceMarketHeld(observedAt, 0);
    const heldByConfirmation = (row: PendingDepegRow) => {
      const since = held.get(row.stablecoin_id);
      const at = row.reference_market_held_at;
      return since != null && hasCurrentPendingClosureVerdict(row) && !isExtremeMovePending(row.reason) && at != null && Number.isSafeInteger(at) &&
        at >= Math.max(since, row.first_seen_at, observedAt - stalledGraceSec) && at <= observedAt &&
        row.first_seen_at >= since - extendedExpirySec - stalledGraceSec;
    };
    const stalled = pending.filter((row) => {
      const limitSec = isExtremeMovePending(row.reason) ? severeExpirySec : extendedExpirySec;
      return !heldByConfirmation(row) && row.first_seen_at < observedAt - limitSec - stalledGraceSec;
    });
    const oldestFirstSeen = pending[0]?.first_seen_at ?? null;
    const metadata = {
      pendingCount: pending.length,
      oldestPendingAgeSec: oldestFirstSeen == null ? null : Math.max(0, observedAt - oldestFirstSeen),
      olderThanBaseExpiryCount: olderThanBase.length,
      stalledExpiredCount: stalled.length,
      ...(held.size > 0 && { referenceMarketHeldCount: pending.filter(heldByConfirmation).length }),
      unconfirmedSevereRecent: Number(summary.severe_recent),
      unconfirmedSevereLookbackSec: STATUS_DEPEG_DETECTION_THRESHOLDS.unconfirmedSevereLookbackSec,
      baseExpirySec,
      extendedExpirySec,
      severeExpirySec,
      stalledGraceSec,
      pending: olderThanBase.slice(0, 10).map((row) => ({
        stablecoinId: row.stablecoin_id,
        ageSec: Math.max(0, observedAt - row.first_seen_at),
      })),
    };
    if (Number(summary.severe_recent) > 0) {
      return errorFinding(
        `${summary.severe_recent} extreme-move candidate(s) expired unconfirmed in the last ` +
          `${Math.round(STATUS_DEPEG_DETECTION_THRESHOLDS.unconfirmedSevereLookbackSec / 3600)}h without a public depeg event`,
        metadata,
      );
    }
    if (stalled.length > 0) {
      return errorFinding(
        `${stalled.length} depeg candidate(s) outlived every dynamic expiry limit`,
        metadata,
      );
    }
    return okFinding(metadata);
  } catch (error) {
    return unavailableFinding(error);
  }
}

async function loadPendingCandidates(db: D1Database): Promise<PendingDepegRow[]> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT /* pharos:depeg-pending-aged-candidates */ *
         FROM depeg_pending
         ORDER BY first_seen_at ASC`,
      )
      .all<PendingDepegRow>(),
  );
  return rows.results ?? [];
}

interface DdrUnsealedRow {
  incident_key: string;
  eligible_at: number;
  total_count: number | null;
}

/**
 * A sealed prediction is the only public DDR output for an eligible incident.
 * Reading lock state (not run metadata) catches every cause of a missed seal —
 * a failed promotion-clock read, a crash between seal and publication, or a
 * future regression — and the grace window keeps one transient run quiet.
 * Health deferrals and quarantined events are excluded: each is an intentional
 * non-seal owned by the run's own degraded/quarantine alert.
 */
export async function checkDdrEligibleUnsealed(db: D1Database, observedAt: number) {
  try {
    const graceSec = CRON_INTERVALS["compute-depeg-resolver"] * STATUS_DEPEG_DETECTION_THRESHOLDS.ddrUnsealedGraceIntervals;
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* pharos:ddr-eligible-unsealed-canary */
             ls.incident_key, ls.eligible_at, COUNT(*) OVER () AS total_count
           FROM depeg_resolver_prediction_lock_state ls
           JOIN depeg_resolver_incidents i ON i.incident_key = ls.incident_key
           JOIN depeg_resolver_incident_policy_membership m ON m.incident_key = i.incident_key
           JOIN depeg_events e ON e.id = i.current_event_id
           LEFT JOIN depeg_resolver_public_predictions p ON p.incident_key = ls.incident_key
           WHERE i.incident_state = 'active'
             AND m.policy_universe_included = 1
             AND e.ended_at IS NULL
             AND ls.last_state != 'lock_deferred'
             AND ls.eligible_at <= ?
             AND p.id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM worker_repair_tasks
               WHERE kind = ?
                 AND subject_id = CAST(e.id AS TEXT)
                 AND ${DDR_REPAIR_TASK_ACTIVE_STATE_SQL}
             )
           ORDER BY ls.eligible_at ASC
           LIMIT 50`,
        )
        .bind(observedAt - graceSec, DDR_REPAIR_TASK_KIND)
        .all<DdrUnsealedRow>(),
    );
    const unsealed = rows.results ?? [];
    const unsealedCount = unsealed.length === 0 ? 0 : unsealed[0].total_count;
    if (unsealedCount == null || !Number.isInteger(unsealedCount)) {
      return failedFinding("ddr-unsealed-aggregate-unavailable");
    }
    const oldestEligibleAt = unsealed[0]?.eligible_at ?? null;
    const oldestAgeSec = oldestEligibleAt == null ? null : Math.max(0, observedAt - oldestEligibleAt);
    const metadata = {
      unsealedCount,
      oldestEligibleAt,
      oldestAgeSec,
      graceSec,
      maxAgeSec: STATUS_DEPEG_DETECTION_THRESHOLDS.ddrUnsealedMaxAgeSec,
      incidents: unsealed.slice(0, 10).map((row) => ({
        incidentKey: row.incident_key,
        ageSec: Math.max(0, observedAt - row.eligible_at),
      })),
    };
    if (unsealedCount === 0) return okFinding(metadata);
    if (oldestAgeSec != null && oldestAgeSec > STATUS_DEPEG_DETECTION_THRESHOLDS.ddrUnsealedMaxAgeSec) {
      return errorFinding(
        `${unsealedCount} eligible DDR incident(s) unsealed; oldest ${oldestAgeSec}s past eligibility`,
        metadata,
      );
    }
    return degradedFinding(`${unsealedCount} eligible DDR incident(s) have no sealed prediction`, metadata);
  } catch (error) {
    return unavailableFinding(error);
  }
}

const DEPEG_BLIND_EVENT_REVIEW_MAX_AGE_SEC = 14 * 86_400;
const reviewClockSchema = z.number().int().positive().max(8_640_000_000_000);
export const DepegBlindEventReviewSchema = z.object({
  eventId: z.number().int().positive(),
  stablecoinId: z.string().refine((id) => ACTIVE_IDS.has(id)),
  owner: z.literal("ops"),
  reason: z.string().trim().min(1),
  sources: z.array(z.string().url().startsWith("https://")).min(1),
  reviewedAt: reviewClockSchema,
  expiresAt: reviewClockSchema,
}).refine((review) => review.expiresAt > review.reviewedAt
  && review.expiresAt - review.reviewedAt <= DEPEG_BLIND_EVENT_REVIEW_MAX_AGE_SEC);

/** O2: acknowledge only operator blind-coverage findings, never depeg evidence or lifecycle. */
export const DEPEG_BLIND_EVENT_REVIEWS: readonly z.infer<typeof DepegBlindEventReviewSchema>[] = [
  {
    eventId: 91042, stablecoinId: "pathusd-bridge", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 91042 remains open and blind (blindAge 355,911s); CoinGecko-only single-source primary ($0.999389, observed 12:30:51 UTC) displays -6 bps and remains confirm_required. DEX priced contributors are $50,000 from one pool in one direct_api family (Tempo, $0.999925), observed 2,205 seconds before the capture (outside the unchanged 2,100-second family freshness budget) and below the $1M/two-family floor; the other $49,165,592 of $49,215,592 retained TVL is not priced depth. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 90793, stablecoinId: "xagm-matrixdock", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 90793 remains open and blind (blindAge 4,309,622s); CoinGecko-only single-source primary ($42.23, observed 12:30:51 UTC) displays +301 bps and remains confirm_required. The DEX endpoint reports missing-price, no aggregate and null priced-contributor TVL/count/families; $114,411 retained TVL is not priced depth and unavailable priced metrics are not zero. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/depeg-events?active=true", "https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/matrixdock-silver/tickers"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 90748, stablecoinId: "mai-qidao", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 90748 remains open and blind (blindAge 4,309,622s); CoinGecko-only single-source primary ($0.997744, observed 12:31:10 UTC) displays -23 bps and remains confirm_required. Of $2,209,834 retained DEX TVL, only $329,308 supplies three priced contributor pools across two families ($203,155 cg_onchain KyberSwap Elastic Arbitrum at $0.96726 and $126,153 direct_api Balancer Polygon at $0.99776), far below the unchanged $1M priced-TVL floor. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 84563, stablecoinId: "uusd-youves", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 84563 remains open and blind (blindAge 4,309,622s); DefiLlama-only single-source primary ($0.998895) displays -11 bps, carries no upstream observation clock and remains confirm_required. The DEX endpoint reports missing-price, no aggregate, null priced-contributor TVL/count/families and $0 retained TVL; unavailable priced metrics are not zero. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 90804, stablecoinId: "wars-argentine-peso", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 90804 remains open and blind (blindAge 3,404,241s); CoinGecko-only single-source primary ($0.0005656, observed 12:30:51 UTC) displays -1,065 bps and remains confirm_required. DEX priced contributors are $57,400 from one pool in one cg_onchain family (Uniswap V4, Worldchain), observed 45,094 seconds before the capture and far outside the unchanged 2,100-second family freshness budget; $1,345,128 retained TVL is not priced depth. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/argentine-peso/tickers", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 91037, stablecoinId: "usdr-rise", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 91037 remains open and blind (blindAge 1,318,060s); DefiLlama-only single-source primary ($1.009457) displays +95 bps, carries no upstream observation clock and remains confirm_required. The DEX endpoint reports missing-price, no aggregate and null priced-contributor TVL/count/families; $8,179,918 retained TVL is not priced depth and unavailable priced metrics are not zero. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://explorer.risechain.com/address/0xCBc0c0d2782f97077A6309e28B9B70Dc73a934D2"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 90807, stablecoinId: "xaum-matrixdock", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 90807 remains open and blind (blindAge 302,775s); CoinGecko-only single-source primary ($3,537.33, observed 12:30:51 UTC) displays -26 bps and remains confirm_required. DEX priced contributors are $664,988 from three pools in one cg_onchain family ($406,736 PancakeSwap BSC, $151,285 Uniswap V4 BSC, $106,967 Uniswap V3 Ethereum, observed 1,894 seconds before the capture), below the $1M floor and one family short. $1,188,203 retained TVL is not priced depth. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/matrixdock-gold/tickers", "https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 89787, stablecoinId: "pmusd-precious-metals", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 89787 (open since 2026-05-02, peak -6,902 bps) remains open and blind (blindAge 298,365s); primary publishes only coingecko-onchain-address fallback ($0.466295, -5,337 bps, observed 12:24:50 UTC), not an authoritative depeg source. The DEX endpoint reports missing-price, no aggregate and null priced-contributor TVL/count/families; $6,367,024 retained TVL is not priced depth and unavailable priced metrics are not zero. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true", "https://api.coingecko.com/api/v3/coins/precious-metals-usd?localization=false&tickers=true&community_data=false&developer_data=false"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 90773, stablecoinId: "usda-alpha-partner", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 90773 remains open and blind (blindAge 298,365s); CoinGecko-only single-source primary ($0.880596, observed 12:30:51 UTC) displays -1,194 bps and remains confirm_required. DEX priced contributors are $9,984,010 from one pool in one direct_api family (PancakeSwap, BSC, $0.878886), observed 2,205 seconds before the capture (outside the 2,100-second family freshness budget) and one family short of the two-family aggregate floor; $15,533,298 is retained TVL. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
  {
    eventId: 90738, stablecoinId: "cngn-compliant-naira", owner: "ops",
    reason: "Re-reviewed 2026-11-22 12:38 UTC from the 12:38:30 UTC public API capture: event 90738 remains open and blind (blindAge 298,365s); CoinGecko-only single-source primary ($0.0006925, observed 12:30:51 UTC) displays -626 bps and remains confirm_required. DEX priced contributors are $73,276 from one pool in one cg_onchain family (Aerodrome, Base), observed 45,094 seconds before the capture and far outside the unchanged 2,100-second family freshness budget; $445,115 retained TVL is below the $1M floor. No authoritative primary or admitted $1M/two-family aggregate appears in the capture. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 22, 12, 38) / 1000, expiresAt: Date.UTC(2026, 11, 6, 12, 38) / 1000,
  },
];

export function resolveDepegBlindEventReviews(nowSec: number, reviews: readonly unknown[] = DEPEG_BLIND_EVENT_REVIEWS) {
  const activeById = new Map<number, z.infer<typeof DepegBlindEventReviewSchema>>();
  if (!reviewClockSchema.safeParse(nowSec).success) return activeById;
  const seen = new Set<number>();
  for (const entry of reviews) {
    const id = typeof entry === "object" && entry !== null && "eventId" in entry ? entry.eventId : null;
    if (typeof id === "number") {
      if (seen.has(id)) {
        activeById.delete(id);
        continue;
      }
      seen.add(id);
    }
    const parsed = DepegBlindEventReviewSchema.safeParse(entry);
    if (!parsed.success) continue;
    const review = parsed.data;
    if (review.reviewedAt <= nowSec && nowSec < review.expiresAt) activeById.set(review.eventId, review);
  }
  return activeById;
}

interface BlindOpenEventRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  last_trusted_price_at: number | null;
  price_coverage_gap_started_at: number | null;
  blind_since?: number;
  total_count: number | null;
  acknowledged_count: number | null;
  acknowledged_ids_json: string | null;
  notice_ids_json?: string | null;
}

/**
 * An open event whose trusted price stopped advancing stays open with a frozen
 * clock and is only labelled "unconfirmed" on the coin page. The persisted
 * coverage clock names the stuck leg inline, without waiting for a whole-run
 * census loss. `gapStartedAt` breaks off-peg continuity and is preserved by a
 * later at-par observation, so the effective blind clock is the newer of the
 * two columns rather than the gap alone. Frozen coins are exempt: their open
 * rows are preserved history that is never observed or force-closed again.
 */
export async function checkDepegOpenCoverage(db: D1Database, observedAt: number) {
  try {
    const reviews = resolveDepegBlindEventReviews(observedAt);
    const [run] = await loadDepegCensusRuns(db, 1);
    const notices = run?.pipelineSucceeded && run.runStartedAt <= observedAt &&
      run.census && run.census.evaluatedAt >= run.runStartedAt
      ? freshDepegDeadBandNotices(run.census.deadBandNotices, observedAt)
        .filter((notice) => notice.evaluatedAt === run.census!.evaluatedAt) : [];
    const blindBefore = observedAt - STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec;
    // Detection holds FX and metal events blind while their reference market is shut; a gap
    // that was already blind when the closure began stays actionable.
    const held = referenceMarketHeld(observedAt, STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec);
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `WITH blind AS (SELECT /* pharos:depeg-open-coverage-canary */
             id, stablecoin_id, symbol, last_trusted_price_at, price_coverage_gap_started_at,
             CASE WHEN EXISTS (SELECT 1 FROM json_each(?) AS review
               WHERE depeg_events.id = json_extract(review.value, '$.eventId')
                 AND depeg_events.stablecoin_id = json_extract(review.value, '$.stablecoinId')) THEN 1 ELSE 0 END AS acknowledged,
             CASE WHEN EXISTS (SELECT 1 FROM json_each(?) AS notice
               WHERE depeg_events.id = json_extract(notice.value, '$.eventId')
                 AND depeg_events.stablecoin_id = json_extract(notice.value, '$.stablecoinId')) THEN 1 ELSE 0 END AS unresolved
           FROM depeg_events
           WHERE ended_at IS NULL
             AND stablecoin_id NOT IN (SELECT value FROM json_each(?))
             AND (last_trusted_price_at IS NOT NULL OR price_coverage_gap_started_at IS NOT NULL)
           ),
           closure AS (SELECT json_extract(value, '$.id') AS asset_id,
             json_extract(value, '$.since') AS closure_start,
             json_extract(value, '$.after') AS pre_close_cutoff FROM json_each(?)),
           clocked AS (
             SELECT blind.*, closure.pre_close_cutoff, CASE
               WHEN price_coverage_gap_started_at >= closure.closure_start
                 AND last_trusted_price_at < closure.pre_close_cutoff THEN last_trusted_price_at
               ELSE MAX(COALESCE(last_trusted_price_at, 0), COALESCE(price_coverage_gap_started_at, 0))
             END AS blind_since
             FROM blind LEFT JOIN closure ON closure.asset_id = blind.stablecoin_id
           ),
           actionable AS (
             SELECT * FROM clocked WHERE blind_since < ?
               AND (pre_close_cutoff IS NULL OR blind_since < pre_close_cutoff)
           )
           SELECT *, COUNT(*) OVER () AS total_count, SUM(acknowledged) OVER () AS acknowledged_count,
             (SELECT JSON_GROUP_ARRAY(DISTINCT id) FROM actionable WHERE acknowledged = 1) AS acknowledged_ids_json,
             (SELECT JSON_GROUP_ARRAY(DISTINCT id) FROM actionable WHERE acknowledged = 0 AND unresolved = 1) AS notice_ids_json
           FROM actionable
           ORDER BY acknowledged ASC, blind_since ASC
           LIMIT 25`,
        )
        .bind(JSON.stringify([...reviews.values()].map(({ eventId, stablecoinId }) => ({ eventId, stablecoinId }))),
          JSON.stringify(notices), JSON.stringify([...FROZEN_IDS]), JSON.stringify([...held].map(([id, since]) =>
            ({ id, since, after: since - STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec }))), blindBefore)
        .all<BlindOpenEventRow>(),
    );
    const blind = rows.results ?? [];
    const blindEventCount = blind.length === 0 ? 0 : blind[0].total_count;
    const acknowledgedBlindEventCount = blind.length === 0 ? 0 : blind[0].acknowledged_count;
    const acknowledgedBlindReviewIds = blind.length === 0 ? []
      : z.array(z.number().int().positive()).parse(JSON.parse(blind[0].acknowledged_ids_json ?? "null"));
    if (blindEventCount == null || !Number.isSafeInteger(blindEventCount) || blindEventCount < blind.length
      || acknowledgedBlindEventCount == null || !Number.isSafeInteger(acknowledgedBlindEventCount)
      || acknowledgedBlindEventCount < 0 || acknowledgedBlindEventCount > blindEventCount
      || acknowledgedBlindReviewIds.length !== acknowledgedBlindEventCount
      || new Set(acknowledgedBlindReviewIds).size !== acknowledgedBlindReviewIds.length
      || (acknowledgedBlindEventCount > 0 && acknowledgedBlindReviewIds.length === 0)
      || !acknowledgedBlindReviewIds.every((id) => reviews.has(id))) {
      return failedFinding("depeg-open-coverage-aggregate-unavailable");
    }
    const noticeIds = blind.length === 0 ? [] : z.array(z.number().int().positive()).parse(
      JSON.parse(blind[0].notice_ids_json ?? "[]"));
    const unresolvedBlindEvents = notices.filter((notice) => noticeIds.includes(notice.eventId));
    if (unresolvedBlindEvents.length !== noticeIds.length || new Set(noticeIds).size !== noticeIds.length ||
      unresolvedBlindEvents.length + acknowledgedBlindEventCount > blindEventCount) {
      return failedFinding("depeg-open-coverage-aggregate-unavailable");
    }
    const unresolvedBlindEventCount = unresolvedBlindEvents.length;
    const actionableBlindEventCount = blindEventCount - acknowledgedBlindEventCount - unresolvedBlindEventCount;
    // Partition the existing detail sample so counts/review IDs survive the canary metadata cap.
    const events = blind.slice(0, 10).map((row) => ({
      eventId: row.id, stablecoinId: row.stablecoin_id, symbol: row.symbol,
      blindAgeSec: Math.max(0, observedAt - (row.blind_since ?? Math.max(row.last_trusted_price_at ?? 0, row.price_coverage_gap_started_at ?? 0))),
    }));
    const acknowledgedBlindEvents = events.filter((event) => reviews.get(event.eventId)?.stablecoinId === event.stablecoinId);
    const actionableBlindEvents = events.filter((event) => reviews.get(event.eventId)?.stablecoinId !== event.stablecoinId && !noticeIds.includes(event.eventId));
    const metadata = {
      blindEventCount,
      unresolvedBlindEventCount,
      unresolvedBlindEvents,
      deadBandNoticesShownCount: run?.census?.deadBandNoticesShownCount ?? null,
      deadBandNoticesOmittedCount: run?.census?.deadBandNoticesOmittedCount ?? null,
      evidenceBudgets: { aggregateMaxAgeSec: DEX_FRESHNESS_SEC, familyMaxAgeSec: DEX_PROTOCOL_SOURCE_FRESHNESS_SEC,
        minTvlUsd: DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD },
      acknowledgedBlindEventCount,
      actionableBlindEventCount,
      acknowledgedBlindReviewIds,
      acknowledgedBlindEvents,
      actionableBlindEvents,
      acknowledgedBlindEventsTruncated: acknowledgedBlindEventCount > acknowledgedBlindEvents.length,
      actionableBlindEventsTruncated: actionableBlindEventCount > actionableBlindEvents.length,
      blindMaxAgeSec: STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec,
      ...(held.size > 0 && { referenceMarketHeldAssetCount: held.size }),
      events,
    };
    // The persistence envelope truncates oversized metadata as a whole. Do not
    // suppress blindness if the complete contributor receipt cannot survive it.
    if (unresolvedBlindEventCount > 0 && JSON.stringify(metadata).length > CANARY_METADATA_BUDGET) {
      return degradedFinding("depeg-open-coverage-receipt-over-budget", { ...metadata,
        unresolvedBlindEventCount: 0, unresolvedBlindEvents: [],
        actionableBlindEventCount: blindEventCount - acknowledgedBlindEventCount,
        actionableBlindEvents: events.filter((event) => reviews.get(event.eventId)?.stablecoinId !== event.stablecoinId),
        actionableBlindEventsTruncated: blindEventCount - acknowledgedBlindEventCount > events.length - acknowledgedBlindEvents.length });
    }
    if (actionableBlindEventCount === 0) return okFinding(metadata);
    return degradedFinding(
      `${actionableBlindEventCount} unreviewed open depeg event(s) have no trusted price observation within ${STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec}s: ` +
        actionableBlindEvents.slice(0, 5).map((event) => `${event.symbol}(${event.stablecoinId})`).join(", "),
      metadata,
    );
  } catch (error) {
    return unavailableFinding(error);
  }
}

interface DexSuppressionCandidateRow {
  stablecoin_id: string;
  dex_price_usd: number;
  primary_price_at_calc: number;
  deviation_from_primary_bps: number | null;
  source_total_tvl: number;
  price_sources_json: string | null;
  candidate_count: number | null;
}

const DEX_SUPPRESSION_CANDIDATE_LIMIT = 50;

/**
 * Mirrors the onset-suppression predicate for USD pegs: the primary is beyond
 * the trigger, the aggregate DEX price is inside the recovery band with at
 * least two corroborating protocol groups, and neither an open event nor a
 * pending candidate exists. Suppression is deliberate but silent, so a
 * persistent disagreement between the two price authorities is operator news.
 */
export async function checkDepegDexSuppression(db: D1Database, observedAt: number) {
  try {
    const thresholdBps = getDepegThresholdBps("peggedUSD");
    const recoveryBps = getDepegRecoveryThresholdBps("peggedUSD");
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* pharos:depeg-dex-suppression-canary */
             stablecoin_id, dex_price_usd, primary_price_at_calc,
             deviation_from_primary_bps, source_total_tvl, price_sources_json,
             COUNT(*) OVER () AS candidate_count
           FROM dex_prices
           WHERE updated_at >= ?
             AND source_total_tvl >= ?
             AND dex_price_usd > 0
             AND primary_price_at_calc > 0
             AND ABS(dex_price_usd - 1) * 10000 <= ?
             AND ABS(primary_price_at_calc - 1) * 10000 >= ?
             AND NOT EXISTS (
               SELECT 1 FROM depeg_events e
               WHERE e.stablecoin_id = dex_prices.stablecoin_id AND e.ended_at IS NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM depeg_pending p
               WHERE p.stablecoin_id = dex_prices.stablecoin_id
             )
           ORDER BY ABS(primary_price_at_calc - 1) DESC
           LIMIT ${DEX_SUPPRESSION_CANDIDATE_LIMIT}`,
        )
        .bind(observedAt - DEX_FRESHNESS_SEC, DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD, recoveryBps, thresholdBps)
        .all<DexSuppressionCandidateRow>(),
    );
    const candidates = rows.results ?? [];
    const candidateCount = candidates.length === 0 ? 0 : candidates[0].candidate_count;
    if (candidateCount == null || !Number.isInteger(candidateCount)) {
      return failedFinding("depeg-dex-suppression-aggregate-unavailable");
    }
    // The protocol-group predicate is JS policy; a saturated candidate scan
    // makes the published suppressed count a lower bound, which the finding
    // names instead of reporting it as a full population (ADR-34).
    const suppressedCountIsLowerBound = candidateCount > candidates.length;
    const suppressed = candidates.flatMap((row) => {
      const meta = PSI_ELIGIBLE_META_BY_ID.get(row.stablecoin_id);
      // USD pegs anchor at 1, so the suppression predicate is computable here;
      // non-USD references need the run's FX-annotated peg table.
      if (meta?.flags.pegCurrency !== "USD") return [];
      const sources = parseDexSources(row.price_sources_json, observedAt);
      const direction = row.primary_price_at_calc < 1 ? "below" : "above";
      const groups = collectDexProtocolCorroborations(sources, 1, recoveryBps, direction, "recover").length;
      if (groups < 2) return [];
      return [{
        stablecoinId: row.stablecoin_id,
        primaryBps: Math.round((Math.abs(row.primary_price_at_calc - 1) * 10_000)),
        dexBps: Math.round(Math.abs(row.dex_price_usd - 1) * 10_000),
        protocolGroups: groups,
        sourceTotalTvlUsd: Math.round(row.source_total_tvl),
      }];
    });
    const suppressedLabel = suppressedCountIsLowerBound
      ? `at least ${suppressed.length}`
      : `${suppressed.length}`;
    const metadata = {
      suppressedCount: suppressed.length,
      suppressedCountIsLowerBound,
      candidateCount,
      candidateLimit: DEX_SUPPRESSION_CANDIDATE_LIMIT,
      thresholdBps,
      recoveryBps,
      minTvlUsd: DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
      maxDexAgeSec: DEX_FRESHNESS_SEC,
      suppressed: suppressed.slice(0, 10),
    };
    if (suppressed.length === 0) return okFinding(metadata);
    if (suppressed.length >= STATUS_DEPEG_DETECTION_THRESHOLDS.dexSuppressionErrorCount) {
      return errorFinding(
        `${suppressedLabel} USD-pegged assets have a DEX-recovery onset suppression with no pending candidate or open event`,
        metadata,
      );
    }
    return degradedFinding(
      `DEX price recovery band suppressed a new depeg onset for ${suppressed.map((row) => row.stablecoinId).join(", ")}` +
        (suppressedCountIsLowerBound ? " (candidate scan capped)" : ""),
      metadata,
    );
  } catch (error) {
    return unavailableFinding(error);
  }
}

/** Only fresh, individually clocked protocol observations count as corroboration. */
function parseDexSources(value: string | null, observedAt: number): DexPoolSource[] {
  if (value == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  return (getDexPriceSourceEntries(parsed) ?? []).filter((entry): entry is DexPoolSource => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const source = entry as Partial<DexPoolSource>;
    if (typeof source.protocol !== "string" || typeof source.price !== "number" || !Number.isFinite(source.price)) return false;
    if (typeof source.observedAt !== "number" || typeof source.aggregateObservedAt !== "number") return false;
    const sourceAgeSec = observedAt - source.observedAt;
    const aggregateAgeSec = observedAt - source.aggregateObservedAt;
    return sourceAgeSec >= 0 && sourceAgeSec <= DEX_PROTOCOL_SOURCE_FRESHNESS_SEC
      && aggregateAgeSec >= 0 && aggregateAgeSec <= DEX_FRESHNESS_SEC;
  });
}
