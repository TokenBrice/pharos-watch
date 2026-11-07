import {
  DEX_FRESHNESS_SEC,
  DEX_PROTOCOL_SOURCE_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
} from "@shared/lib/depeg-config";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { STATUS_DEPEG_DETECTION_THRESHOLDS } from "@shared/lib/status-thresholds";
import { toErrorMessage } from "@shared/lib/error-utils";
import { z } from "zod";
import {
  getDepegRecoveryThresholdBps,
  getDepegThresholdBps,
} from "./constants";
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
  DEPEG_CENSUS_PRODUCER_JOB,
  latestDepegLedgerRun,
  loadDepegCensusRuns,
} from "./depeg-ledger-clock";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { getDexPriceSourceEntries } from "./depeg-trust-policy";
import type { DepegObservationCensus } from "../cron/depeg-detection/types";
import { resolveStablecoinMarketHours, resolveStablecoinPriceGapReviews } from "./stablecoin-publication-coverage";

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
  const reviews = resolveStablecoinPriceGapReviews(ids, observedAt);
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

export const DEPEG_BLIND_EVENT_REVIEW_MAX_AGE_SEC = 14 * 86_400;
const reviewClockSchema = z.number().int().positive().max(8_640_000_000_000);
export const DepegBlindEventReviewSchema = z.object({
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
    stablecoinId: "xagm-matrixdock", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; DEX priced contributors $71,745 in one cg_onchain family ($71,661 currently), below the unchanged $1M/two-family floor. Displayed deviation +179 bps at 19:31 UTC; event 90793 remains open and blind. No authoritative primary or admissible independent market was verified. Review only structural blind coverage; no recovery or price-trust claim.",
    sources: ["https://api.pharos.watch/api/depeg-events?active=true", "https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/matrixdock-silver/tickers"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "hollar-hydrated", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary, no admitted DEX price or contributor families (published priced TVL $0 in the prior census), below the unchanged $1M/two-family floor. Displayed deviation -32 bps at 19:31 UTC; event 90786 remains open and blind. Hydration EMA 1.00266293 USDC/HOLLAR at block 16621877 lacks resolved freshness, executable depth and independent USDC conversion; conditional HSM buyback is not an authoritative primary. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://docs.hydration.net/products/hollar/"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "mai-qidao", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; $3,483,705.56 retained DEX TVL supplies only $127,488 priced contributors in one direct_api family, below the unchanged $1M/two-family floor. Displayed deviation -40 bps at 19:31 UTC; event 90748 remains open and blind. Pinned Aerodrome 0.980675 USDC/MAI versus Balancer 0.995692 USDC.e/MAI differ by about 153 bps before USD conversion; no authoritative primary was verified. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://basescan.org/address/0x2a1463CeBE85315224c536AfD389b381B43F3206", "https://polygonscan.com/address/0x06Df3b2bbB68adc8B0e302443692037ED9f91b42"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "uusd-youves", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: DefiLlama-only primary, no admitted DEX price or contributor families (published priced TVL $0 in the prior census), below the unchanged $1M/two-family floor. Displayed deviation +31 bps at 19:31 UTC; event 84563 remains open and blind. Tezos/TzKT pool discovery is supported but reserve-ratio crawling is not an independent admitted market-price producer; no authoritative primary was verified. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "wars-argentine-peso", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; $1,110,473.73 retained DEX TVL has no admitted aggregate or contributor families (Celo V3 retained liquidity $106,558; large rows unpriced). Displayed deviation -640 bps at 19:31 UTC; event 90804 remains open and blind. Ten CoinGecko tickers are DEX markets; ARS references and backing reports are not executable token prices. No authoritative primary or unchanged $1M/two-family corroboration was verified. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/argentine-peso/tickers", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "vnxau-vnx", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; DEX priced contributors $428,655 ($428,408 currently), all one direct_api family across Raydium/Aero/Orca, below the unchanged $1M/two-family floor. Displayed deviation -103 bps at 19:31 UTC; event 90808 remains open and blind. XT's ticker was stale at 2026-11-06 22:26:53 UTC; VNX disclaims trading services. No authoritative primary was verified. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/vnx-gold/tickers", "https://vnx.li/vnxau"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "usda-alpha-partner", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; DEX priced contributors $16,063,488 ($16,146,046 currently) exceed $1M but have only one cg_onchain family. Displayed deviation -937 bps at 19:31 UTC; event 90773 remains open and blind. USDA/USDT V3 holds only $8,395.90; existing BSC V2 capture implies $0.9070177983/USDA from pinned reserves and an observed USDT mark but is execution evidence, not a second admitted price producer or authoritative primary. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://bscscan.com/address/0xde66f1b24002c1d743ad1ef13cd4b2474295a6f6", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "pathusd-bridge", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; $70,537,705 priced DEX TVL ($70,520,756 currently) exceeds $1M but tempo and uniswap-v4 both have cg_onchain provenance, one independent family. Displayed deviation +14 bps at 19:31 UTC; event 90802 remains open and blind. Convertible V4 pathUSD/USDC.e and USDT0/pathUSD pools hold only $12,539.59 and $3,448.09; Tempo has no registered CLOB price producer or authoritative primary. Review only structural blind coverage; protocol labels do not establish recovery.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://tempo.xyz/developers/docs/protocol/exchange/spec.md", "https://apidocs.bridge.xyz/platform/issuance/faq.md"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "xaum-matrixdock", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; $726,605 priced DEX TVL ($726,509 currently) across cg_onchain and direct_api is below the unchanged $1M floor despite two families. Displayed deviation +25 bps at 19:31 UTC; event 90807 remains open and blind. KuCoin XAUM/USDT 4075.93 at 19:57:02 UTC is outside existing direct CEX producers, and issuer gold references are not observed token prices. No authoritative primary was verified. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/matrixdock-gold/tickers", "https://data.chain.link/feeds/bsc/mainnet/xaum-reference-rate"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "usdr-rise", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: prior DefiLlama-only primary displayed +81 bps at 19:31 UTC with no admitted aggregate despite $8,138,708.23 retained TVL. Current primary is dex-promoted/single-source at $1.01700048; priced TVL $8,089,757 is one cg_onchain family, still lacking the unchanged second independent family. Event 91037 remains open and blind. Pinned six-word Icarus CLPool slot0 gives 1.0001713483 USDC.e/USDR, not independently valued USD or an admitted authoritative primary. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/stablecoins", "https://api.pharos.watch/api/dex-liquidity", "https://explorer.risechain.com/address/0xCBc0c0d2782f97077A6309e28B9B70Dc73a934D2"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
  {
    stablecoinId: "brz-transfero", owner: "ops",
    reason: "Reviewed dpg/dpg3 evidence and 2026-11-07 20:57 UTC public reads: CoinGecko-only primary; $775,653.03 retained DEX TVL and $461,426 priced contributors ($461,338 currently) stay below the unchanged $1M floor despite two dl/cg_onchain families. Displayed deviation -240 bps at 19:31 UTC; event 91038 remains open and blind. Current CoinGecko tickers are DEX markets; BRL references and single-asset reserve evidence do not provide an executable redemption mark or authoritative primary. Review only structural blind coverage.",
    sources: ["https://api.pharos.watch/api/dex-liquidity", "https://api.coingecko.com/api/v3/coins/brz/tickers", "https://api.pharos.watch/api/depeg-events?active=true"],
    reviewedAt: Date.UTC(2026, 10, 7, 21) / 1000, expiresAt: Date.UTC(2026, 10, 14, 21) / 1000,
  },
];

export function resolveDepegBlindEventReviews(nowSec: number, reviews: readonly unknown[] = DEPEG_BLIND_EVENT_REVIEWS) {
  const activeById = new Map<string, z.infer<typeof DepegBlindEventReviewSchema>>();
  if (!reviewClockSchema.safeParse(nowSec).success) return activeById;
  const seen = new Set<string>();
  for (const entry of reviews) {
    const id = typeof entry === "object" && entry !== null && "stablecoinId" in entry ? entry.stablecoinId : null;
    if (typeof id === "string") {
      if (seen.has(id)) {
        activeById.delete(id);
        continue;
      }
      seen.add(id);
    }
    const parsed = DepegBlindEventReviewSchema.safeParse(entry);
    if (!parsed.success) continue;
    const review = parsed.data;
    if (review.reviewedAt <= nowSec && nowSec < review.expiresAt) activeById.set(review.stablecoinId, review);
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
    const blindBefore = observedAt - STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec;
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `WITH blind AS (SELECT /* pharos:depeg-open-coverage-canary */
             id, stablecoin_id, symbol, last_trusted_price_at, price_coverage_gap_started_at,
             CASE WHEN stablecoin_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END AS acknowledged
           FROM depeg_events
           WHERE ended_at IS NULL
             AND stablecoin_id NOT IN (SELECT value FROM json_each(?))
             AND (last_trusted_price_at IS NOT NULL OR price_coverage_gap_started_at IS NOT NULL)
             AND MAX(COALESCE(last_trusted_price_at, 0), COALESCE(price_coverage_gap_started_at, 0)) < ?
           )
           SELECT *, COUNT(*) OVER () AS total_count, SUM(acknowledged) OVER () AS acknowledged_count,
             (SELECT JSON_GROUP_ARRAY(DISTINCT stablecoin_id) FROM blind WHERE acknowledged = 1) AS acknowledged_ids_json
           FROM blind
           ORDER BY acknowledged ASC, MAX(COALESCE(last_trusted_price_at, 0), COALESCE(price_coverage_gap_started_at, 0)) ASC
           LIMIT 25`,
        )
        .bind(JSON.stringify([...reviews.keys()]), JSON.stringify([...FROZEN_IDS]), blindBefore)
        .all<BlindOpenEventRow>(),
    );
    const blind = rows.results ?? [];
    const blindEventCount = blind.length === 0 ? 0 : blind[0].total_count;
    const acknowledgedBlindEventCount = blind.length === 0 ? 0 : blind[0].acknowledged_count;
    const acknowledgedBlindReviewIds = blind.length === 0 ? []
      : z.array(z.string()).parse(JSON.parse(blind[0].acknowledged_ids_json ?? "null"));
    if (blindEventCount == null || !Number.isSafeInteger(blindEventCount) || blindEventCount < blind.length
      || acknowledgedBlindEventCount == null || !Number.isSafeInteger(acknowledgedBlindEventCount)
      || acknowledgedBlindEventCount < 0 || acknowledgedBlindEventCount > blindEventCount
      || acknowledgedBlindReviewIds.length > acknowledgedBlindEventCount
      || new Set(acknowledgedBlindReviewIds).size !== acknowledgedBlindReviewIds.length
      || (acknowledgedBlindEventCount > 0 && acknowledgedBlindReviewIds.length === 0)
      || !acknowledgedBlindReviewIds.every((id) => reviews.has(id))) {
      return failedFinding("depeg-open-coverage-aggregate-unavailable");
    }
    const actionableBlindEventCount = blindEventCount - acknowledgedBlindEventCount;
    // Partition the existing detail sample so counts/review IDs survive the canary metadata cap.
    const events = blind.slice(0, 10).map((row) => ({
      eventId: row.id, stablecoinId: row.stablecoin_id, symbol: row.symbol,
      blindAgeSec: Math.max(0, observedAt - Math.max(row.last_trusted_price_at ?? 0, row.price_coverage_gap_started_at ?? 0)),
    }));
    const acknowledgedBlindEvents = events.filter((event) => reviews.has(event.stablecoinId));
    const actionableBlindEvents = events.filter((event) => !reviews.has(event.stablecoinId));
    const metadata = {
      blindEventCount,
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
