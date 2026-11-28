import { reviewedDepegDisputeEvidenceSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import {
  DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
  DEPEG_LONG_RUNNING_AGE_SEC,
  DEPEG_REESCALATION_CONFIRM_MIN_AGE_SEC,
  computeReescalationStepBps,
} from "@shared/lib/depeg-config";
import { advanceDepegPriceCoverage } from "@shared/lib/depeg-price-coverage";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { signalIsWithinThreshold, type DepegSignal } from "@shared/lib/depeg-signals";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { DepegPrimaryTrust } from "@shared/types/price";
import { isMissingTableError } from "../../lib/db";
import {
  PREV_INCIDENT_JSON_FRAGMENT,
  classifySealedRegimeSplit,
  linkedOpenIncidentJsonFragment,
  maxNullableInt,
  readFamilyStats,
  reopenPredecessorJsonFragment,
  resolveOpenIncidentEscalationMetadata,
} from "../../lib/depeg-escalation-metadata";
import { rowPriceCoverage, type DepegEscalationCarryForward } from "../../lib/depeg-helpers";
import { parseJsonObject } from "../../lib/json-parse";
import { getDepegThresholdBps } from "../../lib/depeg-threshold-policy";
import type { DepegDetectionRow, DepegPersistenceCommand } from "./types";

const PREV_DISPUTED_EVIDENCE = reviewedDepegDisputeEvidenceSql("prev", "prev_prov");
const OPEN_EVENT_DISPUTED_EVIDENCE = reviewedDepegDisputeEvidenceSql("open_event", "provenance");

/** Base hydration SELECT used as fallback when DDR auxiliary tables are absent or unreadable. */
export const OPEN_DEPEG_EVENTS_BASE_SELECT = `SELECT open_event.*, COALESCE(provenance.quote_mode,
  CASE WHEN open_event.source = 'live' AND open_event.pending_reason IS NOT NULL
    THEN CASE WHEN instr('+' || open_event.pending_reason || '+', '+native-origin+') > 0 THEN 'native-peg' ELSE 'usd' END
  END) AS quote_mode
  FROM (
    SELECT * FROM depeg_events WHERE ended_at IS NULL LIMIT ?
  ) AS open_event
  LEFT JOIN depeg_event_provenance AS provenance ON provenance.event_id = open_event.id`;

/**
 * Enriched open-event hydration SELECT resolving canonical onset, reviewed-dispute status,
 * and <=6h reopen carry-forward.
 * Bind order: [DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, MAX_OPEN_DEPEG_EVENTS].
 */
export const OPEN_DEPEG_EVENTS_HYDRATION_SELECT = `SELECT open_event.*, COALESCE(provenance.quote_mode,
  CASE WHEN open_event.source = 'live' AND open_event.pending_reason IS NOT NULL
    THEN CASE WHEN instr('+' || open_event.pending_reason || '+', '+native-origin+') > 0 THEN 'native-peg' ELSE 'usd' END
  END) AS quote_mode,
  CASE WHEN COALESCE(${OPEN_EVENT_DISPUTED_EVIDENCE}, 0) = 0 THEN 0 ELSE 1 END AS is_reviewed_disputed,
  ${linkedOpenIncidentJsonFragment("open_event")} AS linked_incident_json,
  ${reopenPredecessorJsonFragment("open_event")} AS reopen_predecessor_json
  FROM (
    SELECT * FROM depeg_events WHERE ended_at IS NULL LIMIT ?
  ) AS open_event
  LEFT JOIN depeg_event_provenance AS provenance ON provenance.event_id = open_event.id`;

const PROMOTION_REOPEN_PREDECESSOR_SELECT = `SELECT
  CASE WHEN typeof(prev.started_at) = 'integer' THEN prev.started_at END AS prev_started_at,
  CASE WHEN typeof(prev.peak_escalation_anchor_bps) = 'integer' AND prev.peak_escalation_anchor_bps > 0 THEN prev.peak_escalation_anchor_bps END AS prev_anchor_bps,
  CASE WHEN typeof(prev.peak_escalated_at) = 'integer' AND prev.peak_escalated_at >= 0 THEN prev.peak_escalated_at END AS prev_escalated_at,
  CASE WHEN prev.peak_escalated_at IS NOT NULL AND (typeof(prev.peak_escalated_at) != 'integer' OR prev.peak_escalated_at < 0) THEN 1 ELSE 0 END AS prev_escalation_invalid,
  ${PREV_INCIDENT_JSON_FRAGMENT} AS incident_json
  FROM depeg_events prev
  LEFT JOIN depeg_event_provenance prev_prov ON prev_prov.event_id = prev.id
 WHERE prev.stablecoin_id = ?
   AND prev.direction = ?
   AND prev.ended_at IS NOT NULL
   AND typeof(prev.ended_at) = 'integer'
   AND ? >= prev.ended_at
   AND ? - prev.ended_at <= ?
   AND COALESCE(${PREV_DISPUTED_EVIDENCE}, 0) = 0
 ORDER BY prev.ended_at DESC, prev.id DESC
 LIMIT 1`;

export interface HydratedOpenEventRawRow extends DepegDetectionRow {
  is_reviewed_disputed?: number | null;
  linked_incident_json?: string | null;
  reopen_predecessor_json?: string | null;
}

export function applyHydratedEscalationMetadata(rawRow: HydratedOpenEventRawRow): DepegDetectionRow {
  const { is_reviewed_disputed, linked_incident_json, reopen_predecessor_json, ...baseRow } = rawRow;
  const resolved = resolveOpenIncidentEscalationMetadata({
    started_at: baseRow.started_at,
    peak_deviation_bps: baseRow.peak_deviation_bps,
    peak_escalated_at: baseRow.peak_escalated_at,
    linked_incident_json,
    reopen_predecessor_json,
  });
  const reviewedDisputed =
    is_reviewed_disputed === 0 ? false : is_reviewed_disputed === 1 ? true : undefined;
  return {
    ...baseRow,
    escalation_metadata_hydrated: true,
    ...(reviewedDisputed !== undefined ? { reviewed_disputed: reviewedDisputed } : {}),
    ...(!resolved.onsetIndeterminate ? { incident_started_at: resolved.incidentStartedAt } : {}),
    ...(resolved.carryForwardAnchorBps != null ? { carry_forward_escalation_anchor_bps: resolved.carryForwardAnchorBps } : {}),
    ...(resolved.carryForwardEscalatedAt != null ? { carry_forward_peak_escalated_at: resolved.carryForwardEscalatedAt } : {}),
  };
}

function isAuxiliaryMissingTableError(err: unknown): boolean {
  return isMissingTableError(err) && !toErrorMessage(err).toLowerCase().includes("depeg_events");
}

export interface ReopenEscalationCandidate {
  peakEscalationAnchorBps: number | null;
  peakEscalatedAt: number | null;
  sealedOutcomeKind: string | null;
  sealedLockTimePeakBps: unknown;
}

interface PromotionPredecessorRow {
  prev_started_at: number | null;
  prev_anchor_bps: number | null;
  prev_escalated_at: number | null;
  prev_escalation_invalid?: number | null;
  incident_json?: string | null;
}

/**
 * Loads the most recent eligible non-disputed closed same-coin, same-direction
 * predecessor within `DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC` (6h) so promotion
 * inserts can carry forward an armed >30d anchor and `peak_escalated_at`.
 * Fails closed (`null`) when auxiliary provenance/DDR tables are absent so
 * unverified disputed or sealed-split predecessors never grant carry-forward.
 */
export async function loadReopenEscalationCandidate(
  db: D1Database,
  params: { stablecoinId: string; direction: string; startedAt: number },
): Promise<ReopenEscalationCandidate | null> {
  let row: PromotionPredecessorRow | null = null;
  try {
    row = await db
      .prepare(PROMOTION_REOPEN_PREDECESSOR_SELECT)
      .bind(
        params.stablecoinId,
        params.direction,
        params.startedAt,
        params.startedAt,
        DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
      )
      .first<PromotionPredecessorRow>();
  } catch (err) {
    if (isAuxiliaryMissingTableError(err)) return null;
    throw err;
  }
  if (!row) return null;

  const incident = parseJsonObject(row.incident_json);
  const stats = readFamilyStats(incident?.familyStats);
  const peakEscalationAnchorBps = maxNullableInt(row.prev_anchor_bps, stats.maxAnchorBps);
  const peakEscalatedAt =
    row.prev_escalation_invalid === 1 || stats.hasInvalidEscalationTs
      ? null
      : maxNullableInt(row.prev_escalated_at, stats.maxEscalatedAt);
  return {
    peakEscalationAnchorBps,
    peakEscalatedAt,
    sealedOutcomeKind: typeof incident?.sealedOutcomeKind === "string" ? incident.sealedOutcomeKind : null,
    sealedLockTimePeakBps: incident?.sealedLockTimePeakBps ?? null,
  };
}

/**
 * Resolves escalation carry-forward for a newly promoted open event.
 * Carries forward only when the predecessor incident was already >30d & armed
 * with a valid threshold-meeting anchor and the reopened tail is verified not to
 * split a sealed regime (withholding inheritance for both split and indeterminate
 * sealed evidence).
 */
export function resolvePromotionEscalationCarryForward(
  promotedPeakDeviationBps: number,
  candidate: ReopenEscalationCandidate | null | undefined,
  pegType?: string,
): DepegEscalationCarryForward | null {
  const minAnchorBps = getDepegThresholdBps(pegType ?? "peggedUSD");
  if (
    !candidate ||
    candidate.peakEscalationAnchorBps == null ||
    !Number.isSafeInteger(candidate.peakEscalationAnchorBps) ||
    candidate.peakEscalationAnchorBps < minAnchorBps
  ) {
    return null;
  }
  if (
    classifySealedRegimeSplit(
      promotedPeakDeviationBps,
      candidate.sealedOutcomeKind,
      candidate.sealedLockTimePeakBps,
    ) !== "not_split"
  ) {
    return null;
  }
  const peakEscalatedAt =
    candidate.peakEscalatedAt != null &&
    Number.isSafeInteger(candidate.peakEscalatedAt) &&
    candidate.peakEscalatedAt >= 0
      ? candidate.peakEscalatedAt
      : null;
  return {
    peakEscalationAnchorBps: candidate.peakEscalationAnchorBps,
    peakEscalatedAt,
  };
}

export interface EscalationDecisionParams {
  now: number;
  existing: DepegDetectionRow;
  nativeEvent: boolean;
  eventSignal: DepegSignal;
  primaryTrust: DepegPrimaryTrust;
  nativeSignal: DepegSignal | null;
  recoveryThreshold: number;
  quoteObservedAt: number | null | undefined;
  nativeObservedAt: number | undefined;
  closedSessionEvidence: boolean;
  peerMoveActive: boolean;
}

function resolveTrustedEscalationClock(params: Omit<EscalationDecisionParams, "eventSignal">): number | null {
  const {
    now,
    existing,
    nativeEvent,
    primaryTrust,
    nativeSignal,
    recoveryThreshold,
    quoteObservedAt,
    nativeObservedAt,
    closedSessionEvidence,
    peerMoveActive,
  } = params;
  // Require strict quote-domain consistency between the event and the observation.
  if (nativeEvent !== isNativePegEvent(existing)) return null;

  if (nativeEvent) {
    if (nativeSignal == null || nativeObservedAt == null) return null;
    if (!Number.isSafeInteger(nativeObservedAt) || nativeObservedAt <= 0 || nativeObservedAt > now || nativeObservedAt < existing.started_at) {
      return null;
    }
    return nativeObservedAt;
  }

  // Gate 2 (USD / benchmark domain): authoritative primary with an admitted observation
  // timestamp only — never `now` fallback, DEX-only, confirm_required, peer-relative, or reference-closed.
  if (primaryTrust !== "authoritative" || peerMoveActive || closedSessionEvidence) return null;
  if (quoteObservedAt == null) return null;
  if (!Number.isSafeInteger(quoteObservedAt) || quoteObservedAt <= 0 || quoteObservedAt > now || quoteObservedAt < existing.started_at) {
    return null;
  }
  // A native quote contradicting the off-peg USD reading cannot confirm escalation.
  if (nativeSignal != null && signalIsWithinThreshold(nativeSignal, recoveryThreshold)) return null;
  return quoteObservedAt;
}

function validAnchorBpsForPeg(value: number | null | undefined, pegThreshold: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= pegThreshold ? value : null;
}

function buildUpdateEscalationIfChanged(
  existing: DepegDetectionRow,
  nextEscalatedAt: number | null,
  nextAnchorBps: number | null,
  nextCandidateAt: number | null,
  nextCandidateSeenAt: number | null,
): Extract<DepegPersistenceCommand, { type: "update-escalation" }> | null {
  const storedEscalatedAt = existing.peak_escalated_at ?? null;
  const storedAnchorBps = existing.peak_escalation_anchor_bps ?? null;
  const storedCandidateAt = existing.peak_escalation_candidate_at ?? null;
  const storedCandidateSeenAt = existing.peak_escalation_candidate_seen_at ?? null;
  if (
    nextEscalatedAt === storedEscalatedAt &&
    nextAnchorBps === storedAnchorBps &&
    nextCandidateAt === storedCandidateAt &&
    nextCandidateSeenAt === storedCandidateSeenAt
  ) {
    return null;
  }
  return {
    type: "update-escalation",
    id: existing.id,
    peakEscalatedAt: nextEscalatedAt,
    peakEscalationAnchorBps: nextAnchorBps,
    peakEscalationCandidateAt: nextCandidateAt,
    peakEscalationCandidateSeenAt: nextCandidateSeenAt,
  };
}

function maybeResetFreshIncidentEscalation(
  existing: DepegDetectionRow,
  now: number,
): Extract<DepegPersistenceCommand, { type: "update-escalation" }> | null {
  // Only reset when canonical onset was explicitly hydrated (so base fallbacks and
  // multi-hop indeterminate reopens never wipe valid carried-forward columns) and
  // the canonical incident is <= 30d old.
  const hydratedStartedAt = existing.incident_started_at;
  if (
    existing.escalation_metadata_hydrated === false ||
    hydratedStartedAt == null ||
    !Number.isFinite(hydratedStartedAt) ||
    hydratedStartedAt <= 0 ||
    hydratedStartedAt > now ||
    now - hydratedStartedAt > DEPEG_LONG_RUNNING_AGE_SEC
  ) {
    return null;
  }
  return buildUpdateEscalationIfChanged(existing, null, null, null, null);
}

/**
 * Evaluates Day-30+ upward-ratcheting re-escalation state for an ongoing same-direction event
 * (including trusted off-peg deadband ticks between recoveryThreshold and openThreshold).
 * Completely decoupled from `update-peak` so peak repairs/DML can never falsely fire escalation.
 */
export function resolveEscalationUpdateCommand(
  params: EscalationDecisionParams,
): Extract<DepegPersistenceCommand, { type: "update-escalation" }> | null {
  const { now, existing, eventSignal } = params;
  if (eventSignal.direction !== existing.direction) return null;

  const pegThreshold = getDepegThresholdBps(existing.peg_type);
  const storedEscalatedAt = existing.peak_escalated_at ?? null;
  const storedAnchorBps = existing.peak_escalation_anchor_bps ?? null;
  const storedCandidateAt = existing.peak_escalation_candidate_at ?? null;
  const storedCandidateSeenAt = existing.peak_escalation_candidate_seen_at ?? null;
  const validStoredAnchorBps = validAnchorBpsForPeg(storedAnchorBps, pegThreshold);
  const validCarryAnchorBps = validAnchorBpsForPeg(existing.carry_forward_escalation_anchor_bps, pegThreshold);
  const storedAnchorInvalid = storedAnchorBps != null && validStoredAnchorBps == null;
  const effectiveAnchorBps = maxNullableInt(validStoredAnchorBps, validCarryAnchorBps);
  const effectiveEscalatedAt = maxNullableInt(storedEscalatedAt, existing.carry_forward_peak_escalated_at ?? null);
  const hasStoredCandidate = storedCandidateAt != null || storedCandidateSeenAt != null;

  // Base hydration fallback (DDR auxiliary tables absent/unreadable): preserve confirmed
  // escalation and stored anchor, clear transient continuity on a newer observation, and
  // require successful metadata hydration before seeding, arming, or confirming so a lower
  // local anchor can never bypass a higher linked family anchor.
  if (existing.escalation_metadata_hydrated === false) {
    if (hasStoredCandidate) {
      const observedAt = resolveTrustedEscalationClock(params);
      const priorLastTrusted = rowPriceCoverage(existing)?.lastTrustedObservationAt ?? null;
      const isReplayedClock =
        priorLastTrusted != null &&
        (observedAt != null ? observedAt <= priorLastTrusted : now <= priorLastTrusted);
      if (!isReplayedClock) {
        return buildUpdateEscalationIfChanged(existing, storedEscalatedAt, storedAnchorBps, null, null);
      }
    }
    return null;
  }

  // Gate 1: Canonical incident age must strictly exceed 30 days. Never arm or fire during Days 0–30.
  const incidentStartedAt = existing.incident_started_at ?? existing.started_at;
  if (!Number.isFinite(incidentStartedAt) || incidentStartedAt <= 0 || incidentStartedAt > now) return null;
  if (now - incidentStartedAt <= DEPEG_LONG_RUNNING_AGE_SEC) {
    const freshReset = maybeResetFreshIncidentEscalation(existing, now);
    if (freshReset) return freshReset;
    // When canonical onset is unavailable (e.g. indeterminate onset) and the physical
    // row is <=30d old, preserve stored anchor and confirmed escalation, but clear any
    // transient armed candidate on a newer observation so non-consecutive wicks cannot confirm.
    if (hasStoredCandidate) {
      const observedAt = resolveTrustedEscalationClock(params);
      const priorLastTrusted = rowPriceCoverage(existing)?.lastTrustedObservationAt ?? null;
      const isReplayedClock =
        priorLastTrusted != null &&
        (observedAt != null ? observedAt <= priorLastTrusted : now <= priorLastTrusted);
      if (!isReplayedClock) {
        return buildUpdateEscalationIfChanged(existing, effectiveEscalatedAt, effectiveAnchorBps, null, null);
      }
    }
    return null;
  }

  // Gate 2: Trusted primary or admitted native same-direction observation with an admitted clock
  // strictly after Day 30. Any intervening escalation-ineligible tick clears an armed candidate
  // so two non-consecutive qualifying wicks cannot confirm across it. A replayed quote (at or
  // before the recorded trusted clock) is not a new tick even when it predates Day 30, so it
  // reaches the replay branch below instead of clearing on the age gate.
  const observedAt = resolveTrustedEscalationClock(params);
  const previousCoverage = rowPriceCoverage(existing);
  const priorLastTrusted = previousCoverage?.lastTrustedObservationAt ?? null;
  const replayedClock = observedAt != null && priorLastTrusted != null && observedAt <= priorLastTrusted;
  if (observedAt == null || (!replayedClock && observedAt - incidentStartedAt <= DEPEG_LONG_RUNNING_AGE_SEC)) {
    return hasStoredCandidate
      ? buildUpdateEscalationIfChanged(existing, effectiveEscalatedAt, effectiveAnchorBps, null, null)
      : null;
  }

  // Malformed stored coverage is unreadable evidence (R2): never arm or confirm from it,
  // and clear any transient armed candidate.
  if (existing.price_coverage_json != null && previousCoverage == null) {
    return hasStoredCandidate
      ? buildUpdateEscalationIfChanged(existing, effectiveEscalatedAt, effectiveAnchorBps, null, null)
      : null;
  }
  const nextCoverage = advanceDepegPriceCoverage(previousCoverage, observedAt, "trusted-off-peg");
  if (nextCoverage.gapStartedAt != null || nextCoverage.lastObservationKind !== "trusted-off-peg") {
    return hasStoredCandidate
      ? buildUpdateEscalationIfChanged(existing, effectiveEscalatedAt, effectiveAnchorBps, null, null)
      : null;
  }

  // Invalidate any candidate armed before Day 30, against an invalid/below-threshold anchor,
  // under a lower qualifying anchor (higher family anchor raises targetBps), or lacking a
  // coherent `peak_escalation_candidate_seen_at >= peak_escalation_candidate_at` clock.
  const anchorIncreasedFromCarryForward =
    effectiveAnchorBps != null && (validStoredAnchorBps == null || effectiveAnchorBps > validStoredAnchorBps);
  const validStoredCandidateAt =
    !storedAnchorInvalid &&
    !anchorIncreasedFromCarryForward &&
    typeof storedCandidateAt === "number" &&
    Number.isSafeInteger(storedCandidateAt) &&
    storedCandidateAt > incidentStartedAt + DEPEG_LONG_RUNNING_AGE_SEC &&
    typeof storedCandidateSeenAt === "number" &&
    Number.isSafeInteger(storedCandidateSeenAt) &&
    storedCandidateSeenAt >= storedCandidateAt
      ? storedCandidateAt
      : null;
  const validStoredCandidateSeenAt = validStoredCandidateAt != null ? storedCandidateSeenAt : null;

  // Re-evaluating the exact same (or older) already-recorded observation cannot seed,
  // reseed, arm, confirm, or shift an armed candidate; only carry-forward sync or
  // invalid-anchor cleanup (if any) applies.
  if (replayedClock) {
    return buildUpdateEscalationIfChanged(
      existing,
      effectiveEscalatedAt,
      effectiveAnchorBps,
      validStoredCandidateAt,
      validStoredCandidateSeenAt,
    );
  }

  // Confirmation requires gap-free trusted off-peg continuity within the 20m continuity budget
  // AND exact equality `priorLastTrusted === validStoredCandidateSeenAt` so no unaccounted
  // coverage advance (e.g., from a rolled-back Worker observing below targetBps or an external
  // write) can bridge two non-consecutive qualifying observations while sustained sub-15m
  // qualifying cadences still confirm once `observedAt >= candidate_at + 15m`.
  const priorCoverageGapFree =
    existing.reference_hold_json == null &&
    previousCoverage != null &&
    previousCoverage.gapStartedAt == null &&
    previousCoverage.lastObservationKind === "trusted-off-peg" &&
    priorLastTrusted != null &&
    observedAt > priorLastTrusted &&
    observedAt - priorLastTrusted <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC &&
    (validStoredCandidateSeenAt == null || priorLastTrusted === validStoredCandidateSeenAt);

  let nextEscalatedAt = effectiveEscalatedAt;
  let nextAnchorBps = effectiveAnchorBps;
  let nextCandidateAt = validStoredCandidateAt;
  let nextCandidateSeenAt = validStoredCandidateSeenAt;

  if (effectiveAnchorBps == null) {
    // First trusted off-peg tick after Day 30 (or reseed after discarding an invalid stored anchor).
    nextAnchorBps = Math.max(eventSignal.absBps, pegThreshold);
    nextCandidateAt = null;
    nextCandidateSeenAt = null;
  } else {
    const targetBps = effectiveAnchorBps + computeReescalationStepBps(effectiveAnchorBps);
    if (eventSignal.absBps >= targetBps) {
      if (
        validStoredCandidateAt == null ||
        validStoredCandidateSeenAt == null ||
        !priorCoverageGapFree ||
        observedAt < validStoredCandidateAt
      ) {
        // First qualifying sample (or fresh sample after an intervening gap / unaccounted advance / anchor raise).
        nextCandidateAt = observedAt;
        nextCandidateSeenAt = observedAt;
      } else if (observedAt >= validStoredCandidateAt + DEPEG_REESCALATION_CONFIRM_MIN_AGE_SEC) {
        // Consecutive trusted qualifying evidence spanning >=15m: confirm escalation and ratchet upward.
        nextEscalatedAt = maxNullableInt(effectiveEscalatedAt, observedAt);
        nextAnchorBps = Math.max(effectiveAnchorBps, eventSignal.absBps);
        nextCandidateAt = null;
        nextCandidateSeenAt = null;
      } else {
        // Distinct qualifying sample <15m after the first qualifying sample: keep `candidate_at`
        // anchored at the window start and advance `candidate_seen_at` to match `lastTrusted`.
        nextCandidateAt = validStoredCandidateAt;
        nextCandidateSeenAt = observedAt;
      }
    } else {
      // Single-tick wick reverted below targetBps: clear candidate without touching anchor.
      nextCandidateAt = null;
      nextCandidateSeenAt = null;
    }
  }

  return buildUpdateEscalationIfChanged(existing, nextEscalatedAt, nextAnchorBps, nextCandidateAt, nextCandidateSeenAt);
}

/**
 * Clears an in-flight escalation candidate when an observation reverts back into recovery,
 * opposite-direction reading, native-quote veto, or other ineligible early exit without
 * closing the event. Also resets stale carried escalation columns when DDR assigns the row
 * to a fresh <=30d incident.
 */
export function resolveEscalationCandidateClearCommand(
  params: Pick<EscalationDecisionParams, "now" | "existing">,
): Extract<DepegPersistenceCommand, { type: "update-escalation" }> | null {
  const { now, existing } = params;
  if (!Number.isSafeInteger(now) || now <= 0 || now < existing.started_at) return null;

  const freshReset = maybeResetFreshIncidentEscalation(existing, now);
  if (freshReset) return freshReset;
  if (existing.peak_escalation_candidate_at == null && existing.peak_escalation_candidate_seen_at == null) return null;

  if (existing.escalation_metadata_hydrated === false) {
    return buildUpdateEscalationIfChanged(
      existing,
      existing.peak_escalated_at ?? null,
      existing.peak_escalation_anchor_bps ?? null,
      null,
      null,
    );
  }

  const pegThreshold = getDepegThresholdBps(existing.peg_type);
  const effectiveAnchorBps = maxNullableInt(
    validAnchorBpsForPeg(existing.peak_escalation_anchor_bps, pegThreshold),
    validAnchorBpsForPeg(existing.carry_forward_escalation_anchor_bps, pegThreshold),
  );
  return buildUpdateEscalationIfChanged(
    existing,
    maxNullableInt(existing.peak_escalated_at ?? null, existing.carry_forward_peak_escalated_at ?? null),
    effectiveAnchorBps,
    null,
    null,
  );
}
