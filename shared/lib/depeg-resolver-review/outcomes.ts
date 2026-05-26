import type { DdrrActualOutcome } from "../../types/depeg-resolver-review";
import type { DdrrActualEventInput, DdrrAssessmentInput } from "./inputs";
import { isTerminalStablecoinStatus } from "../stablecoin-lifecycle";

export interface DdrrDerivedOutcome {
  actualOutcome: DdrrActualOutcome;
  sourceEventState: DdrrActualOutcome;
  actualEndedAt: number | null;
  actualRemainingSec: number | null;
  terminalObserved: boolean;
  dataIssueReason: string | null;
}

function isFiniteNonnegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function hasTerminalEvidence(event: DdrrActualEventInput): boolean {
  return event.terminalObserved === true || isTerminalStablecoinStatus(event.stablecoinStatus);
}

function dataIssue(reason: string, actualEndedAt: number | null = null): DdrrDerivedOutcome {
  return {
    actualOutcome: "data_issue",
    sourceEventState: "data_issue",
    actualEndedAt,
    actualRemainingSec: null,
    terminalObserved: false,
    dataIssueReason: reason,
  };
}

export function deriveActualOutcome(
  assessment: DdrrAssessmentInput,
  event: DdrrActualEventInput | null,
): DdrrDerivedOutcome {
  if (!isFiniteNonnegativeInteger(assessment.startedAt) || !isFiniteNonnegativeInteger(assessment.assessedAt)) {
    return dataIssue("malformed_assessment_timestamp");
  }
  if (assessment.assessedAt < assessment.startedAt) {
    return dataIssue("assessment_before_event_start");
  }
  if (event == null) {
    return {
      actualOutcome: "source_event_missing",
      sourceEventState: "source_event_missing",
      actualEndedAt: null,
      actualRemainingSec: null,
      terminalObserved: false,
      dataIssueReason: "source_event_missing",
    };
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
  if (event.endedAt != null && event.endedAt < assessment.assessedAt) {
    return dataIssue("event_end_before_assessment", event.endedAt);
  }

  const terminalObserved = hasTerminalEvidence(event);
  if (event.endedAt != null && event.recoveryPrice != null) {
    return {
      actualOutcome: "recovered",
      sourceEventState: "recovered",
      actualEndedAt: event.endedAt,
      actualRemainingSec: event.endedAt - assessment.assessedAt,
      terminalObserved,
      dataIssueReason: null,
    };
  }
  if (terminalObserved && (event.endedAt == null || event.recoveryPrice == null)) {
    return {
      actualOutcome: "terminal_observed",
      sourceEventState: "terminal_observed",
      actualEndedAt: event.endedAt,
      actualRemainingSec: null,
      terminalObserved: true,
      dataIssueReason: null,
    };
  }
  if (event.endedAt != null && event.recoveryPrice == null) {
    return {
      actualOutcome: "orphan_closed",
      sourceEventState: "orphan_closed",
      actualEndedAt: event.endedAt,
      actualRemainingSec: null,
      terminalObserved: false,
      dataIssueReason: "orphan_closed_without_terminal_evidence",
    };
  }
  return {
    actualOutcome: "still_open",
    sourceEventState: "still_open",
    actualEndedAt: null,
    actualRemainingSec: null,
    terminalObserved: false,
    dataIssueReason: null,
  };
}
