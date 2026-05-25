import type { DdrCellState, DdrHorizon } from "../../types/depeg-resolver";
import type {
  DdrrActualOutcome,
  DdrrDurationReview,
  DdrrHorizonReview,
  DdrrMedianReview,
  DdrrRow,
  DdrrVerdictReview,
} from "../../types/depeg-resolver-review";
import type { DdrrActualEventInput, DdrrAssessmentInput } from "./inputs";
import { deriveActualOutcome, type DdrrDerivedOutcome } from "./outcomes";

export const DDRR_HORIZON_SECONDS: Record<DdrHorizon, number> = {
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};

interface DdrrDurationReviewResult {
  durationReview: DdrrDurationReview;
  medianReview: DdrrMedianReview | null;
  signedErrorSec: number | null;
  absoluteErrorSec: number | null;
  withinIqr: boolean | null;
}

function isDataIssueOutcome(outcome: DdrrActualOutcome): boolean {
  return outcome === "source_event_missing" || outcome === "orphan_closed" || outcome === "data_issue";
}

function isScoreableHorizonState(state: DdrCellState): boolean {
  return state === "benchmarked" || state === "thin_support";
}

function medianReviewForSignedError(signedErrorSec: number): DdrrMedianReview {
  if (signedErrorSec > 0) return "median_late_by";
  if (signedErrorSec < 0) return "median_early_by";
  return "median_exact";
}

export function reviewVerdict(
  assessment: DdrrAssessmentInput,
  outcome: DdrrDerivedOutcome,
): DdrrVerdictReview {
  if (isDataIssueOutcome(outcome.actualOutcome)) return "data_issue";
  if (assessment.resolutionTier === "insufficient_signal") return "unscored_insufficient_signal";
  if (outcome.actualOutcome === "still_open") return "pending";

  if (outcome.actualOutcome === "recovered") {
    if (assessment.resolutionTier === "recovery_unlikely") return "false_terminal";
    return "correct_recoverable";
  }

  if (outcome.actualOutcome === "terminal_observed") {
    if (assessment.resolutionTier === "recovery_unlikely") return "correct_terminal";
    if (assessment.resolutionTier === "at_risk") return "risk_noted_terminal";
    return "false_recoverable";
  }

  return "data_issue";
}

export function reviewDuration(
  assessment: DdrrAssessmentInput,
  outcome: DdrrDerivedOutcome,
): DdrrDurationReviewResult {
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

export function reviewHorizons(
  assessment: DdrrAssessmentInput,
  outcome: DdrrDerivedOutcome,
  nowSec: number,
): DdrrHorizonReview[] {
  const evaluationNow = Number.isFinite(nowSec) ? nowSec : assessment.assessedAt;
  return assessment.horizonCells.map((cell) => {
    const horizonSec = DDRR_HORIZON_SECONDS[cell.horizon];
    const horizonEndAt = assessment.assessedAt + horizonSec;
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

export function reviewDepegResolverAssessment(
  assessment: DdrrAssessmentInput,
  actualEvent: DdrrActualEventInput | null,
  nowSec: number,
): DdrrRow {
  const outcome = deriveActualOutcome(assessment, actualEvent);
  const verdictReview = reviewVerdict(assessment, outcome);
  const duration = reviewDuration(assessment, outcome);
  const horizonReviews = reviewHorizons(assessment, outcome, nowSec);

  return {
    eventId: assessment.eventId,
    stablecoinId: assessment.stablecoinId,
    symbol: assessment.symbol,
    name: assessment.name,
    pegCurrency: assessment.pegCurrency,
    governance: assessment.governance,
    direction: assessment.direction,
    startedAt: assessment.startedAt,
    assessedAt: assessment.assessedAt,
    eventAgeSec: assessment.eventAgeSec,
    checkpoint: assessment.checkpoint,
    methodologyVersion: assessment.methodologyVersion,
    resolutionTier: assessment.resolutionTier,
    durationSuppressed: assessment.durationSuppressed,
    durationSuppressedReason: assessment.durationSuppressedReason,
    predictedRemainingSec: assessment.predictedRemainingSec,
    iqrRemainingSec: assessment.iqrRemainingSec,
    actualOutcome: outcome.actualOutcome,
    actualEndedAt: outcome.actualEndedAt,
    actualRemainingSec: outcome.actualRemainingSec,
    verdictReview,
    durationReview: duration.durationReview,
    medianReview: duration.medianReview,
    signedErrorSec: duration.signedErrorSec,
    absoluteErrorSec: duration.absoluteErrorSec,
    withinIqr: duration.withinIqr,
    horizonReviews,
    stratum: assessment.stratum,
    factors: assessment.factors,
    sourceEventState: outcome.sourceEventState,
  };
}
