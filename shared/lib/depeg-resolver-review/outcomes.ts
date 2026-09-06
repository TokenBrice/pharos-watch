import type { DdrrActualOutcome, DdrrSourceEventState } from "../../types/depeg-resolver-review";
import type { DdrrActualEventInput, DdrrAssessmentInput } from "./inputs";
import { classifyDepegClosure } from "../depeg-closure";
import { isTerminalStablecoinStatus } from "../stablecoin-lifecycle";

export interface DdrrDerivedOutcome {
  actualOutcome: DdrrActualOutcome;
  sourceEventState: DdrrSourceEventState;
  actualEndedAt: number | null;
  actualRemainingSec: number | null;
  terminalObserved: boolean;
  terminalEvidenceAt: number | null;
  terminalEvidenceInterval: { start: number; end: number } | null;
  terminalEvidencePrecision: "day" | "month" | "unknown" | null;
  dataIssueReason: string | null;
}

function isFiniteNonnegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function hasTerminalEvidence(event: DdrrActualEventInput): boolean {
  return event.terminalObserved === true || isTerminalStablecoinStatus(event.stablecoinStatus);
}
export function actualOutcomeFromSourceEventState(sourceEventState: DdrrSourceEventState): DdrrActualOutcome {
  switch (sourceEventState) {
    case "active":
      return "still_open";
    case "missing":
      return "source_missing";
    case "recovered":
    case "terminal":
    case "orphan_closed":
    case "data_issue":
    case "invalidated":
      return sourceEventState;
  }
}

function dataIssue(reason: string, actualEndedAt: number | null = null): DdrrDerivedOutcome {
  return {
    actualOutcome: "data_issue",
    sourceEventState: "data_issue",
    actualEndedAt,
    actualRemainingSec: null,
    terminalObserved: false,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    dataIssueReason: reason,
  };
}

function sourceMissingOutcome(): DdrrDerivedOutcome {
  return {
    actualOutcome: "source_missing",
    sourceEventState: "missing",
    actualEndedAt: null,
    actualRemainingSec: null,
    terminalObserved: false,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    dataIssueReason: "source_event_missing",
  };
}

function terminalOutcome(input: {
  actualEndedAt: number | null;
  terminalEvidenceAt: number | null;
  terminalEvidenceInterval: { start: number; end: number } | null;
  terminalEvidencePrecision: "day" | "month" | "unknown" | null;
}): DdrrDerivedOutcome {
  return {
    actualOutcome: "terminal",
    sourceEventState: "terminal",
    actualEndedAt: input.actualEndedAt,
    actualRemainingSec: null,
    terminalObserved: true,
    terminalEvidenceAt: input.terminalEvidenceAt,
    terminalEvidenceInterval: input.terminalEvidenceInterval,
    terminalEvidencePrecision: input.terminalEvidencePrecision,
    dataIssueReason: null,
  };
}

function isTerminalEvidenceSettledBy(
  terminalEvidenceAt: number | null,
  terminalEvidenceInterval: { start: number; end: number } | null,
  endedAt: number,
): boolean {
  if (terminalEvidenceAt == null || terminalEvidenceAt > endedAt) return false;
  if (terminalEvidenceInterval == null) return true;
  return terminalEvidenceInterval.end <= endedAt;
}

export function getAssessmentReviewAnchorSec(assessment: DdrrAssessmentInput): number {
  return assessment.lockedAt ?? assessment.assessedAt;
}

export function deriveActualOutcome(
  assessment: DdrrAssessmentInput,
  event: DdrrActualEventInput | null,
): DdrrDerivedOutcome {
  const anchorSec = getAssessmentReviewAnchorSec(assessment);
  if (
    !isFiniteNonnegativeInteger(assessment.startedAt) ||
    !isFiniteNonnegativeInteger(assessment.assessedAt) ||
    !isFiniteNonnegativeInteger(anchorSec)
  ) {
    return dataIssue("malformed_assessment_timestamp");
  }
  if (anchorSec < assessment.startedAt) {
    return dataIssue("assessment_before_event_start");
  }
  if (event == null) {
    return sourceMissingOutcome();
  }
  if (event.eventId !== assessment.eventId) {
    return dataIssue("event_id_mismatch", event.endedAt);
  }
  if (!isFiniteNonnegativeInteger(event.startedAt)) {
    return dataIssue("malformed_event_start", event.endedAt);
  }
  if (event.endedAt != null && !isFiniteNonnegativeInteger(event.endedAt)) {
    return dataIssue("malformed_event_end", event.endedAt);
  }
  if (event.recoveryPrice != null && (!Number.isFinite(event.recoveryPrice) || event.recoveryPrice <= 0)) {
    return dataIssue("malformed_recovery_price", event.endedAt);
  }
  if (event.endedAt == null && event.recoveryPrice != null) {
    return dataIssue("recovery_price_without_event_end", null);
  }
  if (event.endedAt != null && event.endedAt < event.startedAt) {
    return dataIssue("event_end_before_event_start", event.endedAt);
  }
  if (event.endedAt != null && event.endedAt < anchorSec) {
    return dataIssue("event_end_before_review_anchor", event.endedAt);
  }

  const terminalObserved = hasTerminalEvidence(event);
  const terminalEvidenceAt = event.terminalEvidenceAt ?? null;
  const terminalEvidenceInterval = event.terminalEvidenceInterval ?? null;
  const terminalEvidencePrecision = event.terminalEvidencePrecision ?? null;
  const closure = classifyDepegClosure(event);
  const recovered = closure === "recovered" || closure === "legacy_recovered";
  if (
    terminalObserved &&
    recovered &&
    event.endedAt != null &&
    isTerminalEvidenceSettledBy(terminalEvidenceAt, terminalEvidenceInterval, event.endedAt)
  ) {
    return terminalOutcome({
      actualEndedAt: event.endedAt,
      terminalEvidenceAt,
      terminalEvidenceInterval,
      terminalEvidencePrecision,
    });
  }
  if (recovered && event.endedAt != null) {
    return {
      actualOutcome: "recovered",
      sourceEventState: "recovered",
      actualEndedAt: event.endedAt,
      actualRemainingSec: event.endedAt - anchorSec,
      terminalObserved,
      terminalEvidenceAt,
      terminalEvidenceInterval,
      terminalEvidencePrecision,
      dataIssueReason: null,
    };
  }
  if (terminalObserved && !recovered) {
    return terminalOutcome({
      actualEndedAt: event.endedAt,
      terminalEvidenceAt,
      terminalEvidenceInterval,
      terminalEvidencePrecision,
    });
  }
  if (event.endedAt != null) {
    return {
      actualOutcome: "orphan_closed",
      sourceEventState: "orphan_closed",
      actualEndedAt: event.endedAt,
      actualRemainingSec: null,
      terminalObserved: false,
      terminalEvidenceAt,
      terminalEvidenceInterval,
      terminalEvidencePrecision,
      dataIssueReason: "orphan_closed_without_terminal_evidence",
    };
  }
  return {
    actualOutcome: "still_open",
    sourceEventState: "active",
    actualEndedAt: null,
    actualRemainingSec: null,
    terminalObserved: false,
    terminalEvidenceAt,
    terminalEvidenceInterval,
    terminalEvidencePrecision,
    dataIssueReason: null,
  };
}
