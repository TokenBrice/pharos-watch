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
  latestDepegLedgerRun,
  loadDepegCensusRuns,
} from "./depeg-ledger-clock";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { getDexPriceSourceEntries } from "./depeg-trust-policy";
import type { DepegObservationCensus } from "../cron/depeg-detection/types";
import { resolveStablecoinMarketHours, resolveStablecoinPriceGapReviews } from "./stablecoin-publication-coverage";
import { PSI_HISTORICAL_PRICE_GAP_REVIEWS, STABLECOIN_PRICE_GAP_REVIEWS } from "./stablecoin-publication-reviews";

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

function unavailableShare(census: { eligibleCount: number; unavailableCount: number }): number | null {
  return census.eligibleCount > 0 ? census.unavailableCount / census.eligibleCount : null;
}

/** Operator completeness only: source facts never acknowledge detection or event blindness. */
export function assessDepegObservationGaps(census: DepegObservationCensus, observedAt: number) {
  const acknowledgedUnavailableIds = {
    reviewedNominalReference: [] as string[],
    scheduledMarketClosure: [] as string[],
    reviewedPriceGap: [] as string[],
  };
  // Identities exist only for primary-unusable gaps; a census without any has nothing to acknowledge.
  const primaryUnusableCount = census.reasonCounts["primary-unusable"] ?? 0;
  const assets = census.unavailableAssets ?? (primaryUnusableCount === 0 ? [] : undefined);
  const unavailableIdsComplete = census.unavailableIdsTruncated !== true && !census.unavailableIdsDropped
    && assets != null && new Set(assets.map((asset) => asset.id)).size === assets.length
    && assets.filter((asset) => asset.reason === "primary-unusable").length === primaryUnusableCount;
  if (!unavailableIdsComplete) {
    return { unavailableIdsComplete: false, acknowledgedUnavailableCount: 0,
      actionableUnavailableCount: census.unavailableCount, acknowledgedUnavailableIds,
      actionableUnavailableIds: null, actionableReasonCounts: census.reasonCounts };
  }
  const ids = assets.map((asset) => asset.id);
  const marketHours = resolveStablecoinMarketHours(ids, census.evaluatedAt);
  const reviews = resolveStablecoinPriceGapReviews(ids, observedAt, [
    ...STABLECOIN_PRICE_GAP_REVIEWS.filter((review) => ACTIVE_IDS.has(review.stablecoinId)),
    ...PSI_HISTORICAL_PRICE_GAP_REVIEWS.filter((review) => PSI_HISTORICAL_IDS.has(review.stablecoinId)),
  ]);
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
    }
    actionableUnavailableIds.push(asset.id);
  }
  const acknowledgedUnavailableCount = Object.values(acknowledgedUnavailableIds).reduce((sum, list) => sum + list.length, 0);
  const actionableReasonCounts: DepegObservationCensus["reasonCounts"] = { ...census.reasonCounts };
  if (primaryUnusableCount > acknowledgedUnavailableCount) {
    actionableReasonCounts["primary-unusable"] = primaryUnusableCount - acknowledgedUnavailableCount;
  } else {
    delete actionableReasonCounts["primary-unusable"];
  }
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
    const latest = latestDepegLedgerRun(runs);
    if (latest?.census == null) {
      return degradedFinding("depeg-census-missing", {
        producerJob: DEPEG_CENSUS_PRODUCER_JOB,
        latestRunAt: runs[0].runStartedAt,
        unavailableReason: runs[0].unavailableReason,
        maxAgeSec,
      });
    }
    const census = latest.census;
    const ageSec = Math.max(0, observedAt - latest.runStartedAt);
    const prior = runs.find(
      (run) => run.runStartedAt < latest.runStartedAt && run.pipelineSucceeded && run.census != null,
    ) ?? null;
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

interface PendingConfirmationRow {
  stablecoin_id: string;
  first_seen_at: number;
  reason: string | null;
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
    // A non-extreme candidate cannot outlive the extended limit; an extreme
    // move gets the severe limit. One producer interval of grace keeps the
    // run that may still keep the row from being reported before the next run
    // can expire it.
    const stalled = pending.filter((row) => {
      const limitSec = isExtremeMovePending(row.reason) ? severeExpirySec : extendedExpirySec;
      return row.first_seen_at < observedAt - limitSec - stalledGraceSec;
    });
    const oldestFirstSeen = pending[0]?.first_seen_at ?? null;
    const metadata = {
      pendingCount: pending.length,
      oldestPendingAgeSec: oldestFirstSeen == null ? null : Math.max(0, observedAt - oldestFirstSeen),
      olderThanBaseExpiryCount: olderThanBase.length,
      stalledExpiredCount: stalled.length,
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

async function loadPendingCandidates(db: D1Database): Promise<PendingConfirmationRow[]> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT /* pharos:depeg-pending-aged-candidates */
           stablecoin_id, first_seen_at, reason
         FROM depeg_pending
         ORDER BY first_seen_at ASC`,
      )
      .all<PendingConfirmationRow>(),
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
    reason: "Reviewed 2026-11-12 20:29 UTC from the 20:00:16 UTC public API capture: event 91042 remains open and blind; CoinGecko-only single-source pricing displays +48 bps and is confirm_required. DEX priced TVL is $40,416,012 across seven contributor pools and two independent families: cg_onchain $40,366,012 and direct_api $50,000. At collection their observations were 2,796 and 3,560 seconds old, both outside the unchanged 2,100-second family freshness budget. Neither family observation is admitted by the consumer, so the $1 aggregate is not admitted as two-family depeg corroboration despite sufficient raw depth and breadth. This acknowledgement becomes false if either family is admitted, a trusted primary is available, or the event closes; reassess then. Review only blind coverage; no recovery, price-trust or admission-rule change.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 29) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 29) / 1000,
  },
  {
    eventId: 91040, stablecoinId: "audd-novatti", owner: "ops",
    reason: "Reviewed 2026-11-12 20:04 UTC from the 20:00:16 UTC public API capture: CoinGecko-only single-source primary displays -224 bps and remains confirm_required. DEX explicitly reports missing-price, no aggregate and null priced-contributor TVL/count/families; even all $596,162.84 retained TVL is below the unchanged $1M floor. Retained dl/direct_api/cg_onchain/horizon inventory is not priced-family evidence. The same-day direct Coinbase read at 19:33 UTC had trade time 18:50:33 UTC, about 43 minutes old against its 10-minute budget; that is historical corroboration, not a new direct quote or a producer-health claim. No authoritative alternative is admitted in the captured primary. Event 91040 remains open and blind. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true", "https://api.exchange.coinbase.com/products/AUDD-USDC/ticker"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 4) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 4) / 1000,
  },
  {
    eventId: 90793, stablecoinId: "xagm-matrixdock", owner: "ops",
    reason: "Reviewed 2026-11-12 20:04 UTC from the 20:00:16 UTC public API capture: CoinGecko-only single-source primary displays +357 bps and remains confirm_required. DEX priced contributors are $71,621 from one pool and one cg_onchain family (Uniswap V3), below the unchanged $1M/two-family floor; $161,847.65 retained TVL is not priced depth. Event 90793 remains open and blind. No authoritative primary or admitted independent aggregate appears in the captured evidence. Review only structural blind coverage, never recovery or price trust.",
    sources: ["https://api.pharos.watch/api/depeg-events?active=true", "https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/matrixdock-silver/tickers"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 4) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 4) / 1000,
  },
  {
    eventId: 90786, stablecoinId: "hollar-hydrated", owner: "ops",
    reason: "Reviewed 2026-11-12 20:04 UTC from the 20:00:16 UTC public API capture: CoinGecko-only single-source primary displays -74 bps and remains confirm_required. The DEX endpoint explicitly reports missing-price, no aggregate, null priced-contributor TVL/count/families and $0 retained TVL with an empty source mix; null metrics are unavailable, not observed zero priced depth. Event 90786 remains open and blind, without an authoritative primary or admitted $1M/two-family aggregate in the capture. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://docs.hydration.net/products/hollar/"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 4) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 4) / 1000,
  },
  {
    eventId: 90748, stablecoinId: "mai-qidao", owner: "ops",
    reason: "Reviewed 2026-11-12 20:04 UTC from the 20:00:16 UTC public API capture: CoinGecko-only single-source primary displays -44 bps and remains confirm_required. Of $2,908,536.36 retained DEX TVL, only $127,822 supplies two priced contributor pools in one direct_api family (Balancer), below the unchanged $1M/two-family floor. Event 90748 remains open and blind. No authoritative primary or admitted independent aggregate appears in the captured evidence. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://basescan.org/address/0x2a1463CeBE85315224c536AfD389b381B43F3206", "https://polygonscan.com/address/0x06Df3b2bbB68adc8B0e302443692037ED9f91b42"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 4) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 4) / 1000,
  },
  {
    eventId: 84563, stablecoinId: "uusd-youves", owner: "ops",
    reason: "Reviewed 2026-11-12 20:04 UTC from the 20:00:16 UTC public API capture: DefiLlama-only single-source primary displays +23 bps and remains confirm_required. The DEX endpoint explicitly reports missing-price, no aggregate, null priced-contributor TVL/count/families and $0 retained TVL with an empty source mix; unavailable priced metrics are not zero. Event 84563 remains open and blind, without an authoritative primary or admitted $1M/two-family aggregate in the capture. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 4) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 4) / 1000,
  },
  {
    eventId: 90804, stablecoinId: "wars-argentine-peso", owner: "ops",
    reason: "Reviewed 2026-11-12 20:04 UTC from the 20:00:16 UTC public API capture: CoinGecko-only single-source primary displays -723 bps and remains confirm_required. DEX explicitly reports missing-price and null priced-contributor TVL/count/families; even all $559,260.55 retained TVL is below the unchanged $1M floor. Retained dl, cg_onchain and gecko_terminal inventory is not priced-family corroboration. Event 90804 remains open and blind. No authoritative primary or admitted independent aggregate appears in the capture. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/argentine-peso/tickers", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 4) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 4) / 1000,
  },
  {
    eventId: 91037, stablecoinId: "usdr-rise", owner: "ops",
    reason: "Reviewed 2026-11-12 20:04 UTC from the 20:00:16 UTC public API capture: the current primary is DefiLlama-only/single-source, displaying +86 bps and remaining confirm_required. DEX explicitly reports missing-price, no aggregate and null priced-contributor TVL/count/families; $8,471,367.99 retained TVL across three Icarus pools has only cg_onchain provenance, not a verified second independent priced family. Unavailable priced metrics are not zero. Event 91037 remains open and blind, without an authoritative primary or admitted $1M/two-family aggregate in the capture. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://explorer.risechain.com/address/0xCBc0c0d2782f97077A6309e28B9B70Dc73a934D2"],
    reviewedAt: Date.UTC(2026, 10, 12, 20, 4) / 1000, expiresAt: Date.UTC(2026, 10, 19, 20, 4) / 1000,
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
             AND MAX(COALESCE(last_trusted_price_at, 0), COALESCE(price_coverage_gap_started_at, 0)) < ?
           )
           SELECT *, COUNT(*) OVER () AS total_count, SUM(acknowledged) OVER () AS acknowledged_count,
             (SELECT JSON_GROUP_ARRAY(DISTINCT id) FROM blind WHERE acknowledged = 1) AS acknowledged_ids_json,
             (SELECT JSON_GROUP_ARRAY(DISTINCT id) FROM blind WHERE acknowledged = 0 AND unresolved = 1) AS notice_ids_json
           FROM blind
           ORDER BY acknowledged ASC, MAX(COALESCE(last_trusted_price_at, 0), COALESCE(price_coverage_gap_started_at, 0)) ASC
           LIMIT 25`,
        )
        .bind(JSON.stringify([...reviews.values()].map(({ eventId, stablecoinId }) => ({ eventId, stablecoinId }))),
          JSON.stringify(notices), JSON.stringify([...FROZEN_IDS]), blindBefore)
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
      blindAgeSec: Math.max(0, observedAt - Math.max(row.last_trusted_price_at ?? 0, row.price_coverage_gap_started_at ?? 0)),
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
