import {
  hasTerminalEvidence,
  type DdrrV2CoverageInput,
} from "@shared/lib/depeg-resolver-review";
import { DDR_V2_EFFECTIVE_AT } from "@shared/lib/depeg-resolver-version";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { numberValue, stringValue } from "@shared/lib/type-guards";
import type { DdrrActualEvent } from "@shared/types/depeg-resolver-review";
import type {
  DdrCanonicalIncident,
  DdrSealedPublicPrediction,
} from "../depeg-resolver-v2-contracts";
import { publicPredictionIdOf } from "../depeg-resolver/storage-adapters";

function payloadStringValue(value: unknown): string | null {
  return stringValue(value, { trim: false });
}

function baseFieldsForIncident(incident: DdrCanonicalIncident, payload: Record<string, unknown>) {
  const meta = TRACKED_META_BY_ID.get(incident.stablecoinId);
  return {
    eventId: incident.eventId,
    currentEventId: incident.currentEventId,
    incidentKey: incident.incidentKey,
    stablecoinId: incident.stablecoinId,
    symbol: payloadStringValue(payload.symbol) ?? meta?.symbol ?? incident.stablecoinId,
    name: payloadStringValue(payload.name) ?? meta?.name ?? payloadStringValue(payload.symbol) ?? incident.stablecoinId,
    pegCurrency: payloadStringValue(payload.pegCurrency) ?? incident.pegCurrency,
    governance: payloadStringValue(payload.governance) ?? meta?.flags.governance ?? "unknown",
    direction: incident.direction,
    startedAt: incident.startedAt,
    eligibleAt: incident.eligibleAt,
  };
}

function coverageEligibilityAt(incident: DdrCanonicalIncident): number {
  if (incident.rolloutActiveAtEnablement === true) {
    return Math.max(incident.eligibleAt, DDR_V2_EFFECTIVE_AT);
  }
  return incident.eligibleAt;
}

function sealedExposureStartedAt(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  payload: Record<string, unknown>,
): number {
  const payloadStartedAt = numberValue(payload.startedAt);
  if (
    payloadStartedAt != null &&
    Number.isInteger(payloadStartedAt) &&
    payloadStartedAt >= 0 &&
    payloadStartedAt <= sealed.lockedAt
  ) {
    return payloadStartedAt;
  }

  const inferredStartedAt = sealed.lockedAt - sealed.eventAgeAtLockSec;
  if (Number.isInteger(inferredStartedAt) && inferredStartedAt >= 0 && inferredStartedAt <= sealed.lockedAt) {
    return inferredStartedAt;
  }

  return Math.min(incident.startedAt, sealed.lockedAt);
}

export function baseFieldsForSealedExposure(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  payload: Record<string, unknown>,
) {
  return {
    ...baseFieldsForIncident(incident, payload),
    eventId: incident.currentEventId,
    currentEventId: incident.currentEventId,
    startedAt: sealedExposureStartedAt(sealed, incident, payload),
    eligibleAt: sealed.eligibleAt,
  };
}

function sourceEventState(actual: DdrrActualEvent | null): DdrrV2CoverageInput["sourceEventState"] {
  if (!actual) return "missing";
  if (hasTerminalEvidence(actual)) return "terminal";
  if (actual.endedAt != null && actual.recoveryPrice != null) return "recovered";
  if (actual.endedAt != null) return "orphan_closed";
  return "active";
}

function terminalEvidenceAtForEligibility(
  actual: DdrrActualEvent | null,
  eligibleAt: number,
): number | null {
  if (!actual) return null;
  const interval = actual.terminalEvidenceInterval ?? null;
  if (interval) {
    if (interval.end <= eligibleAt) return interval.start;
    if (interval.start >= eligibleAt) return interval.start;
    return null;
  }
  return actual.terminalEvidenceAt ?? null;
}

function hasTerminalBeforeEligibility(actual: DdrrActualEvent | null, eligibleAt: number): boolean {
  const evidenceAt = terminalEvidenceAtForEligibility(actual, eligibleAt);
  return evidenceAt != null && evidenceAt < eligibleAt;
}

function hasTerminalStatusOrEvidence(actual: DdrrActualEvent | null): boolean {
  return actual != null && hasTerminalEvidence(actual);
}

function terminalEvidenceSourceDate(actual: DdrrActualEvent | null): string | null {
  if (!actual || !("terminalEvidenceSourceDate" in actual)) return null;
  const value = actual.terminalEvidenceSourceDate;
  return typeof value === "string" ? value : null;
}

function coverageStateForIncident(
  incident: DdrCanonicalIncident,
  actual: DdrrActualEvent | null,
  nowSec: number,
): Pick<DdrrV2CoverageInput, "predictionState" | "coverageCause" | "operationalCoverageCause" | "outcomeQualityState" | "reason"> {
  const reviewEligibleAt = coverageEligibilityAt(incident);
  if (actual == null) {
    return {
      predictionState: "data_quality_gap",
      coverageCause: "data_quality_gap",
      operationalCoverageCause: null,
      outcomeQualityState: "data_quality_gap",
      reason: "source_event_missing",
    };
  }
  if (actual.endedAt != null && actual.recoveryPrice != null && actual.endedAt < reviewEligibleAt) {
    return {
      predictionState: "resolved_before_prediction",
      coverageCause: "pre_lock_recovered",
      operationalCoverageCause: null,
      outcomeQualityState: "classified",
      reason: null,
    };
  }
  if (hasTerminalStatusOrEvidence(actual) && hasTerminalBeforeEligibility(actual, reviewEligibleAt)) {
    return {
      predictionState: "terminal_before_prediction",
      coverageCause: "pre_lock_terminal",
      operationalCoverageCause: null,
      outcomeQualityState: "classified",
      reason: null,
    };
  }
  if (nowSec < reviewEligibleAt) {
    return {
      predictionState: "pending_lock",
      coverageCause: "active_pending_lock",
      operationalCoverageCause: null,
      outcomeQualityState: null,
      reason: null,
    };
  }
  if (actual.endedAt != null && actual.recoveryPrice != null) {
    return {
      predictionState: "missed_lock_recovered",
      coverageCause: "lock_missed",
      operationalCoverageCause: "lock_missed",
      outcomeQualityState: "classified",
      reason: "eligible_incident_closed_without_public_prediction",
    };
  }
  if (actual.endedAt != null) {
    return {
      predictionState: "orphan_closed",
      coverageCause: "orphan_closed",
      operationalCoverageCause: null,
      outcomeQualityState: "orphan_closed",
      reason: "closed_without_recovery_or_terminal_evidence",
    };
  }
  if (hasTerminalStatusOrEvidence(actual)) {
    return {
      predictionState: "missed_lock_terminal",
      coverageCause: "lock_missed",
      operationalCoverageCause: "lock_missed",
      outcomeQualityState: "classified",
      reason: "eligible_terminal_incident_without_public_prediction",
    };
  }
  if (incident.lockState?.lastState === "lock_deferred") {
    return {
      predictionState: "lock_deferred",
      coverageCause: "active_lock_deferred",
      operationalCoverageCause: "system_deferral",
      outcomeQualityState: null,
      reason: incident.lockState.lastDeferralReason,
    };
  }
  return {
    predictionState: "lock_deferred",
    coverageCause: "cron_gap",
    operationalCoverageCause: "cron_gap",
    outcomeQualityState: null,
    reason: "eligible_active_incident_without_public_prediction",
  };
}

export function coverageRowForIncident(
  incident: DdrCanonicalIncident,
  actual: DdrrActualEvent | null,
  nowSec: number,
): DdrrV2CoverageInput {
  const state = coverageStateForIncident(incident, actual, nowSec);
  const terminalEvidenceAt = terminalEvidenceAtForEligibility(actual, coverageEligibilityAt(incident));
  return {
    ...baseFieldsForIncident(incident, {}),
    sourceEventState: sourceEventState(actual),
    terminalEvidenceAt,
    terminalEvidenceInterval: actual?.terminalEvidenceInterval ?? null,
    terminalEvidencePrecision: actual?.terminalEvidencePrecision ?? null,
    actualEndedAt: actual?.endedAt ?? null,
    terminalEvidenceSourceDate: terminalEvidenceSourceDate(actual),
    failedPublication: null,
    ...state,
  };
}

export function failedPublicationCoverageRow(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  actual: DdrrActualEvent | null,
  payload: Record<string, unknown>,
): DdrrV2CoverageInput {
  const publicationFailed = actual != null && (
    actual.endedAt != null ||
    hasTerminalStatusOrEvidence(actual)
  );
  const predictionState = publicationFailed ? "publication_failed" : "publication_retry_pending";
  return {
    ...baseFieldsForIncident(incident, payload),
    eligibleAt: sealed.eligibleAt,
    sourceEventState: sourceEventState(actual),
    terminalEvidenceAt: actual?.terminalEvidenceAt ?? null,
    terminalEvidenceInterval: actual?.terminalEvidenceInterval ?? null,
    terminalEvidencePrecision: actual?.terminalEvidencePrecision ?? null,
    predictionState,
    actualEndedAt: actual?.endedAt ?? null,
    terminalEvidenceSourceDate: terminalEvidenceSourceDate(actual),
    coverageCause: predictionState,
    operationalCoverageCause: predictionState,
    outcomeQualityState: publicationFailed ? "classified" : null,
    reason: publicationFailed
      ? "sealed_prediction_closed_before_first_publication_manifest"
      : "sealed_prediction_not_in_first_publication_manifest",
    failedPublication: {
      publicPredictionId: publicPredictionIdOf(sealed),
      assessmentId: sealed.assessmentId,
      lockedAt: sealed.lockedAt,
      outcomeKind: sealed.outcomeKind,
      rowHash: sealed.rowHash,
      sealedPayloadRedacted: true,
      lastAttemptedAt: sealed.lockedAt,
    },
  };
}

export function buildEffectiveIncidentByKey(incidents: readonly DdrCanonicalIncident[]): Map<string, DdrCanonicalIncident> {
  const byKey = new Map(incidents.map((incident) => [incident.incidentKey, incident]));
  const effective = new Map(byKey);

  for (const alias of incidents) {
    if (alias.incidentState !== "superseded" || !alias.supersededByIncidentKey) continue;
    const canonical = byKey.get(alias.supersededByIncidentKey);
    if (!canonical || canonical.incidentState === "superseded") continue;
    const existing = effective.get(canonical.incidentKey) ?? canonical;
    if (alias.startedAt <= existing.startedAt && alias.currentEventId <= existing.currentEventId) continue;
    effective.set(canonical.incidentKey, {
      ...canonical,
      eventId: alias.currentEventId,
      currentEventId: alias.currentEventId,
    });
  }

  return effective;
}
