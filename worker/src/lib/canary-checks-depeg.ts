import {
  DEX_FRESHNESS_SEC,
  DEX_PROTOCOL_SOURCE_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
} from "@shared/lib/depeg-config";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { STATUS_DEPEG_DETECTION_THRESHOLDS } from "@shared/lib/status-thresholds";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  getDepegRecoveryThresholdBps,
  getDepegThresholdBps,
} from "./constants";
import {
  collectDexProtocolCorroborations,
  type DexPoolSource,
} from "./depeg-helpers";
import {
  DEPEG_CENSUS_PRODUCER_JOB,
  latestDepegLedgerRun,
  loadDepegCensusRuns,
} from "./depeg-ledger-clock";
import { runWithOverloadRetry } from "./d1-overload-retry";

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
      priorRunStartedAt: prior?.runStartedAt ?? null,
    };
    if (ageSec > maxAgeSec) {
      return degradedFinding(`depeg detection census is ${ageSec}s old`, metadata);
    }
    if (
      share != null && priorShare != null
      && share > STATUS_DEPEG_DETECTION_THRESHOLDS.unavailableShareMax
      && priorShare > STATUS_DEPEG_DETECTION_THRESHOLDS.unavailableShareMax
    ) {
      return degradedFinding(
        `depeg observation unavailable for ${census.unavailableCount}/${census.eligibleCount} eligible assets in two consecutive runs`,
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
  stalled_count: number | null;
  pending_count: number | null;
  oldest_first_seen: number | null;
}

interface PendingConfirmationRow {
  stablecoin_id: string;
  first_seen_at: number;
}

/**
 * Pending candidates are deleted with an outcome and never create a
 * `depeg_events` row, so an expired extreme move or a row that outlives every
 * dynamic expiry limit is the only evidence that the confirmation stage
 * stopped promoting. Both are terminal states, not a per-run blip.
 */
export async function checkDepegPendingConfirmation(db: D1Database, observedAt: number) {
  try {
    const baseExpirySec = STATUS_DEPEG_DETECTION_THRESHOLDS.pendingExtendedMaxAgeSec;
    const stalledBefore = observedAt - STATUS_DEPEG_DETECTION_THRESHOLDS.pendingStalledMaxAgeSec;
    const summary = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* pharos:depeg-pending-confirmation-canary */
             (SELECT COUNT(*) FROM depeg_pending_outcomes
               WHERE outcome = 'unconfirmed-severe' AND outcome_at >= ?) AS severe_recent,
             (SELECT COUNT(*) FROM depeg_pending WHERE first_seen_at <= ?) AS stalled_count,
             (SELECT COUNT(*) FROM depeg_pending) AS pending_count,
             (SELECT MIN(first_seen_at) FROM depeg_pending) AS oldest_first_seen`,
        )
        .bind(observedAt - STATUS_DEPEG_DETECTION_THRESHOLDS.unconfirmedSevereLookbackSec, stalledBefore)
        .first<PendingConfirmationSummaryRow>(),
    );
    if (
      !summary
      || !Number.isInteger(summary.severe_recent) || !Number.isInteger(summary.stalled_count)
      || !Number.isInteger(summary.pending_count)
    ) {
      return failedFinding("depeg-pending-aggregate-unavailable");
    }
    const pendingCount = Number(summary.pending_count);
    const oldestFirstSeen = summary.oldest_first_seen == null ? null : Number(summary.oldest_first_seen);
    const olderThanBase = await loadPendingOlderThan(db, observedAt - baseExpirySec);
    const metadata = {
      pendingCount,
      oldestPendingAgeSec: oldestFirstSeen == null ? null : Math.max(0, observedAt - oldestFirstSeen),
      olderThanBaseExpiryCount: olderThanBase.length,
      stalledExpiredCount: Number(summary.stalled_count),
      unconfirmedSevereRecent: Number(summary.severe_recent),
      unconfirmedSevereLookbackSec: STATUS_DEPEG_DETECTION_THRESHOLDS.unconfirmedSevereLookbackSec,
      baseExpirySec,
      stalledExpirySec: STATUS_DEPEG_DETECTION_THRESHOLDS.pendingStalledMaxAgeSec,
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
    if (Number(summary.stalled_count) > 0) {
      return errorFinding(
        `${summary.stalled_count} depeg candidate(s) outlived every dynamic expiry limit`,
        metadata,
      );
    }
    if (olderThanBase.length > 0) {
      return degradedFinding(
        `${olderThanBase.length} depeg candidate(s) remain unresolved past the base confirmation window`,
        metadata,
      );
    }
    return okFinding(metadata);
  } catch (error) {
    return unavailableFinding(error);
  }
}

async function loadPendingOlderThan(db: D1Database, beforeSec: number): Promise<PendingConfirmationRow[]> {
  if (!Number.isFinite(beforeSec)) return [];
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT /* pharos:depeg-pending-aged-candidates */
           stablecoin_id, first_seen_at
         FROM depeg_pending
         WHERE first_seen_at <= ?
         ORDER BY first_seen_at ASC
         LIMIT 20`,
      )
      .bind(beforeSec)
      .all<PendingConfirmationRow>(),
  );
  return rows.results ?? [];
}

interface DdrUnsealedRow {
  incident_key: string;
  eligible_at: number;
}

/**
 * A sealed prediction is the only public DDR output for an eligible incident.
 * Reading lock state (not run metadata) catches every cause of a missed seal —
 * a failed promotion-clock read, a crash between seal and publication, or a
 * future regression — and the grace window keeps one transient run quiet.
 */
export async function checkDdrEligibleUnsealed(db: D1Database, observedAt: number) {
  try {
    const graceSec = CRON_INTERVALS["compute-depeg-resolver"] * STATUS_DEPEG_DETECTION_THRESHOLDS.ddrUnsealedGraceIntervals;
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* pharos:ddr-eligible-unsealed-canary */
             ls.incident_key, ls.eligible_at
           FROM depeg_resolver_prediction_lock_state ls
           JOIN depeg_resolver_incidents i ON i.incident_key = ls.incident_key
           JOIN depeg_resolver_incident_policy_membership m ON m.incident_key = i.incident_key
           JOIN depeg_events e ON e.id = i.current_event_id
           LEFT JOIN depeg_resolver_public_predictions p ON p.incident_key = ls.incident_key
           WHERE i.incident_state = 'active'
             AND m.policy_universe_included = 1
             AND e.ended_at IS NULL
             AND ls.eligible_at <= ?
             AND p.id IS NULL
           ORDER BY ls.eligible_at ASC
           LIMIT 50`,
        )
        .bind(observedAt - graceSec)
        .all<DdrUnsealedRow>(),
    );
    const unsealed = rows.results ?? [];
    const oldestEligibleAt = unsealed[0]?.eligible_at ?? null;
    const oldestAgeSec = oldestEligibleAt == null ? null : Math.max(0, observedAt - oldestEligibleAt);
    const metadata = {
      unsealedCount: unsealed.length,
      oldestEligibleAt,
      oldestAgeSec,
      graceSec,
      maxAgeSec: STATUS_DEPEG_DETECTION_THRESHOLDS.ddrUnsealedMaxAgeSec,
      incidents: unsealed.slice(0, 10).map((row) => ({
        incidentKey: row.incident_key,
        ageSec: Math.max(0, observedAt - row.eligible_at),
      })),
    };
    if (unsealed.length === 0) return okFinding(metadata);
    if (oldestAgeSec != null && oldestAgeSec > STATUS_DEPEG_DETECTION_THRESHOLDS.ddrUnsealedMaxAgeSec) {
      return errorFinding(
        `${unsealed.length} eligible DDR incident(s) unsealed; oldest ${oldestAgeSec}s past eligibility`,
        metadata,
      );
    }
    return degradedFinding(`${unsealed.length} eligible DDR incident(s) have no sealed prediction`, metadata);
  } catch (error) {
    return unavailableFinding(error);
  }
}

interface BlindOpenEventRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  last_trusted_price_at: number | null;
  price_coverage_gap_started_at: number | null;
}

/**
 * An open event whose trusted price stopped advancing stays open with a frozen
 * clock and is only labelled "unconfirmed" on the coin page. The persisted
 * coverage clock names the stuck leg inline, without waiting for a whole-run
 * census loss.
 */
export async function checkDepegOpenCoverage(db: D1Database, observedAt: number) {
  try {
    const blindBefore = observedAt - STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec;
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* pharos:depeg-open-coverage-canary */
             id, stablecoin_id, symbol, last_trusted_price_at, price_coverage_gap_started_at
           FROM depeg_events
           WHERE ended_at IS NULL
             AND (
               (price_coverage_gap_started_at IS NOT NULL AND price_coverage_gap_started_at < ?)
               OR (last_trusted_price_at IS NOT NULL AND last_trusted_price_at < ?)
             )
           ORDER BY price_coverage_gap_started_at ASC
           LIMIT 25`,
        )
        .bind(blindBefore, blindBefore)
        .all<BlindOpenEventRow>(),
    );
    const blind = rows.results ?? [];
    const metadata = {
      blindEventCount: blind.length,
      blindMaxAgeSec: STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec,
      events: blind.slice(0, 10).map((row) => {
        const clock = Math.max(row.last_trusted_price_at ?? 0, row.price_coverage_gap_started_at ?? 0);
        return {
          eventId: row.id,
          stablecoinId: row.stablecoin_id,
          symbol: row.symbol,
          blindAgeSec: Math.max(0, observedAt - clock),
        };
      }),
    };
    if (blind.length === 0) return okFinding(metadata);
    return degradedFinding(
      `${blind.length} open depeg event(s) have no trusted price observation within ${STATUS_DEPEG_DETECTION_THRESHOLDS.openEventBlindMaxAgeSec}s: ` +
        blind.slice(0, 5).map((row) => `${row.symbol}(${row.stablecoin_id})`).join(", "),
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
}

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
             deviation_from_primary_bps, source_total_tvl, price_sources_json
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
           LIMIT 50`,
        )
        .bind(observedAt - DEX_FRESHNESS_SEC, DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD, recoveryBps, thresholdBps)
        .all<DexSuppressionCandidateRow>(),
    );
    const suppressed = (rows.results ?? []).flatMap((row) => {
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
    const metadata = {
      suppressedCount: suppressed.length,
      thresholdBps,
      recoveryBps,
      minTvlUsd: DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
      maxDexAgeSec: DEX_FRESHNESS_SEC,
      suppressed: suppressed.slice(0, 10),
    };
    if (suppressed.length === 0) return okFinding(metadata);
    if (suppressed.length >= STATUS_DEPEG_DETECTION_THRESHOLDS.dexSuppressionErrorCount) {
      return errorFinding(
        `${suppressed.length} USD-pegged assets have a DEX-recovery onset suppression with no pending candidate or open event`,
        metadata,
      );
    }
    return degradedFinding(
      `DEX price recovery band suppressed a new depeg onset for ${suppressed.map((row) => row.stablecoinId).join(", ")}`,
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
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is DexPoolSource => {
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
