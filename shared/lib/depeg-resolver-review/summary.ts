import { mean, median, ratio } from "../stats";
import { DDR_HORIZON_VALUES } from "../../types/depeg-resolver";
import { DDR_PREDICTION_POLICY_VERSION } from "../methodology-versions/depeg-resolver";
import {
  DDRR_COVERAGE_PREDICTION_STATE_VALUES,
  DDRR_SCORED_VERDICTS,
  type DdrrCoveragePredictionState,
  DdrrHorizonCalibration,
  DdrrHorizonHitRate,
  DdrrResponseRow,
  DdrrSummary,
  DdrrV2CoverageResponseRow,
  DdrrV2PredictionReviewRow,
  DdrrV2SummaryMetrics,
  DdrrVerdictReview,
} from "../../types/depeg-resolver-review";
import { isOperationalMissCause } from "./review";

// Headline-scope gate. Distinct from the UI's CALIBRATION_THRESHOLD=5 (calibrating-badge /
// fraction-vs-percentage display gate); both read recoveryLikelihoodScoredCount but are
// deliberately separate decisions — do not merge them.
const HEADLINE_MIN_SCORED_OUTCOMES = 20;

type DdrrDurationScoredPredictionRow = DdrrV2PredictionReviewRow & {
  signedDurationErrorSec: number;
  absoluteDurationErrorSec: number;
};

function countUniqueIncidents(rows: readonly DdrrResponseRow[]): number {
  return new Set(rows.map((row) => row.incidentKey)).size;
}

function summarizeHorizons(rows: readonly DdrrResponseRow[]): DdrrHorizonHitRate[] {
  return DDR_HORIZON_VALUES.map((horizon) => {
    let hits = 0;
    let misses = 0;
    for (const row of rows) {
      if (row.kind !== "prediction_review") continue;
      const review = row.horizonReviews.find((h) => h.horizon === horizon);
      if (review?.result === "hit") hits += 1;
      else if (review?.result === "miss") misses += 1;
    }
    const scored = hits + misses;
    return {
      horizon,
      scored,
      hits,
      misses,
      hitRate: ratio(hits, scored),
    };
  });
}

function summarizeHorizonCalibration(rows: readonly DdrrResponseRow[]): DdrrHorizonCalibration[] {
  const durationRows = rows
    .filter((row): row is DdrrV2PredictionReviewRow => row.kind === "prediction_review")
    .filter(isDurationScoredPredictionRow);
  return DDR_HORIZON_VALUES.map((horizon) => {
    const observations = durationRows.flatMap((row) => {
      const review = row.horizonReviews.find((candidate) => candidate.horizon === horizon);
      if (review?.probability == null || (review.result !== "hit" && review.result !== "miss")) return [];
      return [{ probability: review.probability, observed: review.result === "hit" ? 1 : 0 }];
    });
    const scored = observations.length;
    if (scored === 0) {
      return {
        horizon,
        scored,
        meanPredictedProbability: null,
        realizedClosureShare: null,
        biasPp: null,
        zScore: null,
      };
    }

    const expectedClosures = observations.reduce((sum, observation) => sum + observation.probability, 0);
    const observedClosures = observations.reduce((sum, observation) => sum + observation.observed, 0);
    const variance = observations.reduce(
      (sum, observation) => sum + observation.probability * (1 - observation.probability),
      0,
    );
    const meanPredictedProbability = expectedClosures / scored;
    const realizedClosureShare = observedClosures / scored;
    return {
      horizon,
      scored,
      meanPredictedProbability,
      realizedClosureShare,
      biasPp: (meanPredictedProbability - realizedClosureShare) * 100,
      zScore: variance === 0 ? null : (observedClosures - expectedClosures) / Math.sqrt(variance),
    };
  });
}

function countPredictionVerdicts(rows: readonly DdrrV2PredictionReviewRow[]): Record<DdrrVerdictReview, number> {
  return rows.reduce<Record<DdrrVerdictReview, number>>(
    (counts, row) => {
      counts[row.verdictReview] += 1;
      return counts;
    },
    {
      correct_recoverable: 0,
      correct_terminal: 0,
      false_terminal: 0,
      false_recoverable: 0,
      risk_noted_terminal: 0,
      unscored_insufficient_signal: 0,
      pending: 0,
      data_issue: 0,
    },
  );
}

function countCoveragePredictionStates(
  rows: readonly DdrrV2CoverageResponseRow[],
): Record<DdrrCoveragePredictionState, number> {
  const counts = Object.fromEntries(DDRR_COVERAGE_PREDICTION_STATE_VALUES.map((state) => [state, 0])) as Record<
    DdrrCoveragePredictionState,
    number
  >;
  for (const row of rows) {
    counts[row.predictionState] += 1;
  }
  return counts;
}

function isDurationScoredPredictionRow(row: DdrrV2PredictionReviewRow): row is DdrrDurationScoredPredictionRow {
  return row.signedDurationErrorSec != null && row.absoluteDurationErrorSec != null;
}

export function summarizeDdrrMetrics(rows: readonly DdrrResponseRow[]): DdrrV2SummaryMetrics {
  const predictionRows = rows.filter((row): row is DdrrV2PredictionReviewRow => row.kind === "prediction_review");
  const noCallRows = rows.filter((row) => row.kind === "no_call_review");
  const coverageRows = rows.filter((row) => row.kind === "coverage");
  const invalidatedRows = rows.filter((row) => row.kind === "invalidated_prediction");
  const verdicts = countPredictionVerdicts(predictionRows);
  const coverageStateCounts = countCoveragePredictionStates(coverageRows);

  const recoveryLikelihoodCorrectCount = verdicts.correct_recoverable + verdicts.correct_terminal;
  const recoveryLikelihoodScoredCount = predictionRows.filter((row) =>
    DDRR_SCORED_VERDICTS.has(row.verdictReview),
  ).length;

  const durationRows = predictionRows.filter(isDurationScoredPredictionRow);
  const signedErrors = durationRows.map((row) => row.signedDurationErrorSec);
  const absoluteErrors = durationRows.map((row) => row.absoluteDurationErrorSec);

  const pendingLockCount = coverageStateCounts.pending_lock;
  const lockDeferredCount = coverageStateCounts.lock_deferred;
  const resolvedBeforePredictionCount = coverageStateCounts.resolved_before_prediction;
  const terminalBeforePredictionCount = coverageStateCounts.terminal_before_prediction;
  const dataQualityGapCount = coverageStateCounts.data_quality_gap;
  const orphanClosedCount = coverageStateCounts.orphan_closed;
  const missedLockRecoveredCount = coverageStateCounts.missed_lock_recovered;
  const missedLockTerminalCount = coverageStateCounts.missed_lock_terminal;
  const missedLockOrphanClosedCount = coverageRows.filter(
    (row) => row.predictionState === "orphan_closed" && isOperationalMissCause(row.operationalCoverageCause),
  ).length;
  const missedLockDataQualityGapCount = coverageRows.filter(
    (row) => row.predictionState === "data_quality_gap" && isOperationalMissCause(row.operationalCoverageCause),
  ).length;
  const publicationFailedCount = coverageStateCounts.publication_failed;
  const publicationRetryPendingCount = coverageStateCounts.publication_retry_pending;
  const confirmationTimeUnknownCount = coverageRows.filter(
    (row) => row.operationalCoverageCause === "confirmation_time_unknown",
  ).length;
  const missedOperationalLockCount = coverageRows.filter((row) =>
    isOperationalMissCause(row.operationalCoverageCause),
  ).length;
  const operationalMissOpportunityCount = coverageRows.filter((row) =>
    isOperationalMissCause(row.operationalCoverageCause) || row.predictionState === "publication_failed",
  ).length;
  const missedNoPredictionCount =
    missedLockRecoveredCount + missedLockTerminalCount + missedLockOrphanClosedCount + missedLockDataQualityGapCount;
  const lockedPredictionCount = predictionRows.length;
  const noCallCount = noCallRows.length;
  const invalidatedPredictionCount = invalidatedRows.length;
  const policyUniverseIncidentCount = countUniqueIncidents(rows);
  const activeEligibleIncidentCount = rows.filter((row) => row.sourceEventState === "active").length;
  const currentEligibleOpportunityCount =
    lockedPredictionCount +
    noCallCount +
    lockDeferredCount +
    invalidatedPredictionCount +
    publicationRetryPendingCount +
    publicationFailedCount +
    missedNoPredictionCount;
  const finalizedOpportunityCount =
    lockedPredictionCount + noCallCount + invalidatedPredictionCount + publicationFailedCount + missedNoPredictionCount;
  const stateAssignedCount =
    lockedPredictionCount +
    noCallCount +
    pendingLockCount +
    lockDeferredCount +
    resolvedBeforePredictionCount +
    terminalBeforePredictionCount +
    dataQualityGapCount +
    orphanClosedCount +
    missedNoPredictionCount +
    publicationRetryPendingCount +
    publicationFailedCount +
    invalidatedPredictionCount;
  const finalizedCoverageCount =
    lockedPredictionCount +
    noCallCount +
    resolvedBeforePredictionCount +
    terminalBeforePredictionCount +
    dataQualityGapCount +
    orphanClosedCount +
    missedNoPredictionCount +
    publicationFailedCount +
    invalidatedPredictionCount;
  const invalidatedByReason = invalidatedRows.reduce<Record<string, number>>((counts, row) => {
    const reason = row.latestErratum.reason;
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});

  return {
    activeEligibleIncidentCount,
    policyUniverseIncidentCount,
    lockedPredictionCount,
    pendingLockCount,
    lockDeferredCount,
    resolvedBeforePredictionCount,
    terminalBeforePredictionCount,
    dataQualityGapCount,
    orphanClosedCount,
    missedLockRecoveredCount,
    missedLockTerminalCount,
    missedLockOrphanClosedCount,
    missedLockDataQualityGapCount,
    missedNoPredictionCount,
    publicationFailedCount,
    publicationRetryPendingCount,
    missedOperationalLockCount,
    confirmationTimeUnknownCount,
    noCallCount,
    invalidatedPredictionCount,
    currentEligibleOpportunityCount,
    finalizedOpportunityCount,
    predictionRatePct: ratio(lockedPredictionCount, finalizedOpportunityCount),
    invalidationAdjustedPredictionRatePct: ratio(
      lockedPredictionCount + invalidatedPredictionCount,
      finalizedOpportunityCount,
    ),
    decisionProgressPct: ratio(
      lockedPredictionCount + noCallCount + invalidatedPredictionCount,
      currentEligibleOpportunityCount,
    ),
    operationalMissRatePct: ratio(operationalMissOpportunityCount, currentEligibleOpportunityCount),
    noCallRatePct: ratio(noCallCount, finalizedOpportunityCount),
    preLockRecoveredPct: ratio(resolvedBeforePredictionCount, policyUniverseIncidentCount),
    preLockTerminalPct: ratio(terminalBeforePredictionCount, policyUniverseIncidentCount),
    missedLockPct: ratio(missedNoPredictionCount, policyUniverseIncidentCount),
    stateAssignedPct: ratio(stateAssignedCount, policyUniverseIncidentCount),
    finalizedCoveragePct: ratio(finalizedCoverageCount, policyUniverseIncidentCount),
    recoveryLikelihoodCorrectCount,
    recoveryLikelihoodScoredCount,
    recoveryLikelihoodAccuracyPct: ratio(recoveryLikelihoodCorrectCount, recoveryLikelihoodScoredCount),
    durationScoredCount: durationRows.length,
    meanSignedDurationErrorSec: mean(signedErrors),
    medianSignedDurationErrorSec: median(signedErrors),
    meanAbsoluteDurationErrorSec: mean(absoluteErrors),
    medianAbsoluteDurationErrorSec: median(absoluteErrors),
    invalidatedPct: ratio(invalidatedPredictionCount, policyUniverseIncidentCount),
    invalidatedByReason,
    accuracyDenominatorLabel: "first-published frozen prediction outcomes with observed recovery or terminal evidence",
    horizonHitRates: summarizeHorizons(rows),
    horizonCalibration: summarizeHorizonCalibration(rows),
  };
}

export function summarizeDdrrRows(rows: readonly DdrrResponseRow[]): DdrrSummary {
  const allMetrics = summarizeDdrrMetrics(rows);
  const currentPolicyRows = rows.filter((row) =>
    (row.kind === "prediction_review" || row.kind === "no_call_review" || row.kind === "invalidated_prediction") &&
    row.predictionPolicyVersion === DDR_PREDICTION_POLICY_VERSION,
  );
  const currentPolicyMetrics = summarizeDdrrMetrics(currentPolicyRows);
  const headlineScope =
    currentPolicyMetrics.recoveryLikelihoodScoredCount >= HEADLINE_MIN_SCORED_OUTCOMES
      ? "current_policy"
      : allMetrics.recoveryLikelihoodScoredCount >= HEADLINE_MIN_SCORED_OUTCOMES
        ? "all_ddrv2"
        : "insufficient_data";
  const headline =
    headlineScope === "current_policy"
      ? currentPolicyMetrics
      : allMetrics;
  const headlineLabel =
    headlineScope === "current_policy"
      ? "Current DDRv2 public prediction policy"
      : headlineScope === "all_ddrv2"
        ? "All official DDRv2 public predictions"
        : "Not enough reviewed outcomes for this policy";
  const segments = new Map<string, DdrrResponseRow[]>();
  for (const row of rows) {
    if (row.kind !== "prediction_review" && row.kind !== "no_call_review" && row.kind !== "invalidated_prediction") {
      continue;
    }
    const key = `${row.predictionMethodologyVersion}\u0000${row.predictionPolicyVersion}`;
    const existing = segments.get(key);
    if (existing == null) segments.set(key, [row]);
    else existing.push(row);
  }

  return {
    headlineScope,
    headlineLabel,
    headline,
    // Public segmentation keeps prediction-policy rows separate from coverage
    // debt so accuracy and accountability can be inspected independently.
    byPredictionPolicy: [
      ...[...segments.entries()].map(([key, segmentRows]) => {
        const [predictionMethodologyVersion, predictionPolicyVersion] = key.split("\u0000");
        return {
          segmentKind: "prediction_policy" as const,
          predictionMethodologyVersion,
          predictionPolicyVersion,
          metrics: summarizeDdrrMetrics(segmentRows),
        };
      }),
      {
        segmentKind: "coverage" as const,
        predictionMethodologyVersion: null,
        predictionPolicyVersion: null,
        metrics: summarizeDdrrMetrics(rows.filter((row) => row.kind === "coverage")),
      },
      {
        segmentKind: "all" as const,
        predictionMethodologyVersion: null,
        predictionPolicyVersion: null,
        metrics: allMetrics,
      },
    ],
  };
}
