import type { DdrCellState } from "../../types/depeg-resolver";
import type {
  DdrrActualOutcome,
  DdrrCoverageCause,
  DdrrDurationReview,
  DdrrHorizonReview,
  DdrrMedianReview,
  DdrrV2ActualOutcomeDetail,
  DdrrV2BaseRow,
  DdrrV2CoverageRow,
  DdrrV2InvalidatedPredictionRow,
  DdrrV2NoCallReviewRow,
  DdrrV2PredictionReviewRow,
  DdrrVerdictReview,
} from "../../types/depeg-resolver-review";
import type {
  DdrrActualEventInput,
  DdrrAssessmentInput,
  DdrrV2CoverageInput,
  DdrrV2InvalidatedPredictionInput,
} from "./inputs";
import { deriveActualOutcome, getAssessmentReviewAnchorSec, type DdrrDerivedOutcome } from "./outcomes";
import { HORIZON_SECONDS } from "../depeg-resolver/duration";

interface DdrrDurationReviewResult {
  durationReview: DdrrDurationReview;
  medianReview: DdrrMedianReview | null;
  signedErrorSec: number | null;
  absoluteErrorSec: number | null;
  withinIqr: boolean | null;
}

function isDataIssueOutcome(outcome: DdrrActualOutcome): boolean {
  return (
    outcome === "source_missing" || outcome === "orphan_closed" || outcome === "data_issue" || outcome === "invalidated"
  );
}

function isScoreableHorizonState(state: DdrCellState): boolean {
  return state === "benchmarked" || state === "thin_support";
}

function medianReviewForSignedError(signedErrorSec: number): DdrrMedianReview {
  if (signedErrorSec > 0) return "median_late_by";
  if (signedErrorSec < 0) return "median_early_by";
  return "median_exact";
}

function reviewVerdict(assessment: DdrrAssessmentInput, outcome: DdrrDerivedOutcome): DdrrVerdictReview {
  if (isDataIssueOutcome(outcome.actualOutcome)) return "data_issue";
  if (assessment.resolutionTier === "insufficient_signal") return "unscored_insufficient_signal";
  if (outcome.actualOutcome === "still_open") return "pending";

  if (outcome.actualOutcome === "recovered") {
    if (assessment.resolutionTier === "recovery_unlikely") return "false_terminal";
    return "correct_recoverable";
  }

  if (outcome.actualOutcome === "terminal") {
    if (assessment.resolutionTier === "recovery_unlikely") return "correct_terminal";
    if (assessment.resolutionTier === "at_risk") return "risk_noted_terminal";
    return "false_recoverable";
  }

  // Exhaustive for current DDRR_ACTUAL_OUTCOME_VALUES; retained as a defensive
  // fallback if the public enum grows before this reviewer is updated.
  return "data_issue";
}

function reviewDuration(assessment: DdrrAssessmentInput, outcome: DdrrDerivedOutcome): DdrrDurationReviewResult {
  if (isDataIssueOutcome(outcome.actualOutcome)) {
    return {
      durationReview: "data_issue",
      medianReview: null,
      signedErrorSec: null,
      absoluteErrorSec: null,
      withinIqr: null,
    };
  }
  if (
    assessment.durationSuppressed ||
    assessment.predictedRemainingSec == null ||
    outcome.actualOutcome !== "recovered" ||
    outcome.actualEndedAt == null ||
    outcome.actualRemainingSec == null
  ) {
    return {
      durationReview: "duration_unscored",
      medianReview: null,
      signedErrorSec: null,
      absoluteErrorSec: null,
      withinIqr: null,
    };
  }
  if (
    !Number.isFinite(assessment.predictedRemainingSec) ||
    !Number.isFinite(outcome.actualRemainingSec) ||
    assessment.predictedRemainingSec < 0 ||
    outcome.actualRemainingSec < 0
  ) {
    return {
      durationReview: "data_issue",
      medianReview: null,
      signedErrorSec: null,
      absoluteErrorSec: null,
      withinIqr: null,
    };
  }

  const signedErrorSec = outcome.actualRemainingSec - assessment.predictedRemainingSec;
  const absoluteErrorSec = Math.abs(signedErrorSec);
  const medianReview = medianReviewForSignedError(signedErrorSec);

  if (assessment.iqrRemainingSec == null) {
    return {
      durationReview: medianReview,
      medianReview,
      signedErrorSec,
      absoluteErrorSec,
      withinIqr: null,
    };
  }

  const [iqrLow, iqrHigh] = assessment.iqrRemainingSec;
  if (!Number.isFinite(iqrLow) || !Number.isFinite(iqrHigh) || iqrLow < 0 || iqrHigh < iqrLow) {
    return {
      durationReview: "data_issue",
      medianReview: null,
      signedErrorSec: null,
      absoluteErrorSec: null,
      withinIqr: null,
    };
  }

  const withinIqr = outcome.actualRemainingSec >= iqrLow && outcome.actualRemainingSec <= iqrHigh;
  let durationReview: DdrrDurationReview;
  if (withinIqr) durationReview = "inside_band";
  else if (outcome.actualRemainingSec < iqrLow) durationReview = "faster_than_band";
  else durationReview = "slower_than_band";

  return {
    durationReview,
    medianReview,
    signedErrorSec,
    absoluteErrorSec,
    withinIqr,
  };
}

function reviewHorizons(
  assessment: DdrrAssessmentInput,
  outcome: DdrrDerivedOutcome,
  nowSec: number,
): DdrrHorizonReview[] {
  const evaluationNow = Number.isFinite(nowSec) ? nowSec : assessment.assessedAt;
  const anchorSec = getAssessmentReviewAnchorSec(assessment);
  return assessment.horizonCells.map((cell) => {
    const horizonSec = HORIZON_SECONDS[cell.horizon];
    const horizonEndAt = anchorSec + horizonSec;
    const horizonElapsed = evaluationNow >= horizonEndAt || outcome.actualEndedAt != null;
    const resolvedWithinHorizon =
      outcome.actualOutcome === "recovered" && outcome.actualEndedAt != null && outcome.actualEndedAt <= horizonEndAt;

    let result: DdrrHorizonReview["result"];
    if (isDataIssueOutcome(outcome.actualOutcome) || !isScoreableHorizonState(cell.state) || cell.probability == null) {
      result = "unscored";
    } else if (resolvedWithinHorizon) {
      result = "hit";
    } else if (horizonElapsed) {
      result = "miss";
    } else {
      result = "pending";
    }

    return {
      horizon: cell.horizon,
      horizonSec,
      result,
      horizonElapsed,
      resolvedWithinHorizon,
      sourceCellState: cell.state,
      probability: cell.probability,
      probabilityDisplay: cell.probabilityDisplay,
      probabilityInterval: cell.probabilityInterval,
    };
  });
}

function fallbackPublicPredictionId(assessment: DdrrAssessmentInput): number {
  return assessment.publicPredictionId ?? assessment.eventId;
}

function fallbackAssessmentId(assessment: DdrrAssessmentInput): number {
  return assessment.assessmentId ?? assessment.eventId;
}

function fallbackPredictionPolicyVersion(assessment: DdrrAssessmentInput): string {
  return assessment.predictionPolicyVersion ?? "legacy";
}

function fallbackPublicationSnapshotToken(assessment: DdrrAssessmentInput): string {
  return assessment.publicationSnapshotToken ?? "legacy-unmanifested";
}

function baseRowFromAssessment(assessment: DdrrAssessmentInput, outcome: DdrrDerivedOutcome): DdrrV2BaseRow {
  return {
    eventId: assessment.eventId,
    currentEventId: assessment.currentEventId ?? assessment.eventId,
    incidentKey: assessment.incidentKey ?? `legacy-event:${assessment.eventId}`,
    stablecoinId: assessment.stablecoinId,
    symbol: assessment.symbol,
    name: assessment.name,
    pegCurrency: assessment.pegCurrency,
    governance: assessment.governance,
    direction: assessment.direction,
    startedAt: assessment.startedAt,
    eligibleAt: assessment.eligibleAt ?? assessment.startedAt,
    sourceEventState: outcome.sourceEventState,
    terminalEvidenceAt: outcome.terminalEvidenceAt,
    terminalEvidenceInterval: outcome.terminalEvidenceInterval,
    terminalEvidencePrecision: outcome.terminalEvidencePrecision,
    lineage: assessment.lineage,
  };
}

function actualDetail(outcome: DdrrDerivedOutcome, reviewedAt: number): DdrrV2ActualOutcomeDetail {
  return {
    kind: outcome.actualOutcome,
    actualEndedAt: outcome.actualEndedAt,
    actualRemainingSec: outcome.actualRemainingSec,
    terminalEvidenceAt: outcome.terminalEvidenceAt,
    terminalEvidenceInterval: outcome.terminalEvidenceInterval,
    terminalEvidencePrecision: outcome.terminalEvidencePrecision,
    reviewedAt,
  };
}

export function reviewDepegResolverAssessment(
  assessment: DdrrAssessmentInput,
  actualEvent: DdrrActualEventInput | null,
  nowSec: number,
): DdrrV2PredictionReviewRow {
  const outcome = deriveActualOutcome(assessment, actualEvent);
  const verdictReview = reviewVerdict(assessment, outcome);
  const duration = reviewDuration(assessment, outcome);
  const horizonReviews = reviewHorizons(assessment, outcome, nowSec);
  const lockedAt = getAssessmentReviewAnchorSec(assessment);

  return {
    ...baseRowFromAssessment(assessment, outcome),
    kind: "prediction_review",
    publicPredictionId: fallbackPublicPredictionId(assessment),
    assessmentId: fallbackAssessmentId(assessment),
    predictionState: "frozen",
    predictionMethodologyVersion: assessment.predictionMethodologyVersion ?? assessment.methodologyVersion,
    predictionPolicyVersion: fallbackPredictionPolicyVersion(assessment),
    lockedAt,
    publishedAt: assessment.publishedAt ?? lockedAt,
    publicationSnapshotToken: fallbackPublicationSnapshotToken(assessment),
    frozen: {
      resolutionTier: assessment.resolutionTier,
      predictedRemainingSec: assessment.predictedRemainingSec,
      iqrRemainingSec: assessment.iqrRemainingSec,
      horizonCells: assessment.horizonCells,
      stratum: assessment.stratum,
      factors: assessment.factors,
    },
    actual: actualDetail(outcome, nowSec),
    verdictReview,
    durationReview: duration.durationReview,
    horizonReviews,
    predictedRemainingSec: assessment.predictedRemainingSec,
    actualRemainingSec: outcome.actualRemainingSec,
    signedDurationErrorSec: duration.signedErrorSec,
    absoluteDurationErrorSec: duration.absoluteErrorSec,
    medianReview: duration.medianReview,
    withinIqr: duration.withinIqr,
  };
}

export function reviewDepegResolverNoCall(
  assessment: DdrrAssessmentInput,
  actualEvent: DdrrActualEventInput | null,
  nowSec: number,
): DdrrV2NoCallReviewRow {
  const outcome = deriveActualOutcome(assessment, actualEvent);
  const lockedAt = getAssessmentReviewAnchorSec(assessment);
  return {
    ...baseRowFromAssessment(assessment, outcome),
    kind: "no_call_review",
    publicPredictionId: fallbackPublicPredictionId(assessment),
    assessmentId: fallbackAssessmentId(assessment),
    predictionState: "no_call",
    predictionMethodologyVersion: assessment.predictionMethodologyVersion ?? assessment.methodologyVersion,
    predictionPolicyVersion: fallbackPredictionPolicyVersion(assessment),
    lockedAt,
    publishedAt: assessment.publishedAt ?? lockedAt,
    publicationSnapshotToken: fallbackPublicationSnapshotToken(assessment),
    missingReasons: assessment.durationSuppressedReason == null ? [] : [assessment.durationSuppressedReason],
    actual: actualDetail(outcome, nowSec),
    verdictReview: "unscored_insufficient_signal",
    durationReview: "duration_unscored",
    horizonReviews: [],
  };
}

export function buildDdrrCoverageRow(input: DdrrV2CoverageInput): DdrrV2CoverageRow {
  return {
    eventId: input.eventId,
    currentEventId: input.currentEventId ?? input.eventId,
    incidentKey: input.incidentKey,
    stablecoinId: input.stablecoinId,
    symbol: input.symbol,
    name: input.name,
    pegCurrency: input.pegCurrency,
    governance: input.governance,
    direction: input.direction,
    startedAt: input.startedAt,
    eligibleAt: input.eligibleAt,
    sourceEventState: input.sourceEventState,
    terminalEvidenceAt: input.terminalEvidenceAt ?? null,
    terminalEvidenceInterval: input.terminalEvidenceInterval ?? null,
    terminalEvidencePrecision: input.terminalEvidencePrecision ?? null,
    lineage: input.lineage,
    kind: "coverage",
    predictionState: input.predictionState,
    actualEndedAt: input.actualEndedAt ?? null,
    terminalEvidenceSourceDate: input.terminalEvidenceSourceDate ?? null,
    coverageCause: input.coverageCause,
    operationalCoverageCause: input.operationalCoverageCause ?? null,
    outcomeQualityState: input.outcomeQualityState ?? null,
    reason: input.reason ?? null,
    failedPublication: input.failedPublication ?? null,
  };
}

export function buildDdrrInvalidatedPredictionRow(
  input: DdrrV2InvalidatedPredictionInput,
): DdrrV2InvalidatedPredictionRow {
  return {
    eventId: input.eventId,
    currentEventId: input.currentEventId ?? input.eventId,
    incidentKey: input.incidentKey,
    stablecoinId: input.stablecoinId,
    symbol: input.symbol,
    name: input.name,
    pegCurrency: input.pegCurrency,
    governance: input.governance,
    direction: input.direction,
    startedAt: input.startedAt,
    eligibleAt: input.eligibleAt,
    sourceEventState: input.sourceEventState ?? "invalidated",
    terminalEvidenceAt: input.terminalEvidenceAt ?? null,
    terminalEvidenceInterval: input.terminalEvidenceInterval ?? null,
    terminalEvidencePrecision: input.terminalEvidencePrecision ?? null,
    lineage: input.lineage,
    kind: "invalidated_prediction",
    publicPredictionId: input.publicPredictionId,
    assessmentId: input.assessmentId,
    predictionState: "invalidated",
    predictionMethodologyVersion: input.predictionMethodologyVersion,
    predictionPolicyVersion: input.predictionPolicyVersion,
    lockedAt: input.lockedAt,
    publishedAt: input.publishedAt ?? null,
    publicationSnapshotToken: input.publicationSnapshotToken ?? null,
    originalKind: input.originalKind,
    originalOutcome: input.originalOutcome,
    latestErratum: input.latestErratum,
    errataCount: input.errataCount,
    errataHistory: input.errataHistory,
  };
}

export function isOperationalMissCause(cause: DdrrCoverageCause | null): boolean {
  return cause === "system_deferral" || cause === "cron_gap" || cause === "lock_missed";
}
