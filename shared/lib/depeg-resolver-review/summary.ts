import { DDR_HORIZON_VALUES } from "../../types/depeg-resolver";
import type { DdrrHorizonHitRate, DdrrRow, DdrrSummary, DdrrVerdictReview } from "../../types/depeg-resolver-review";

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function countVerdicts(rows: DdrrRow[]): Record<DdrrVerdictReview, number> {
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

function summarizeHorizons(rows: DdrrRow[]): DdrrHorizonHitRate[] {
  return DDR_HORIZON_VALUES.map((horizon) => {
    let hits = 0;
    let misses = 0;
    for (const row of rows) {
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
      hitRate: scored === 0 ? null : hits / scored,
    };
  });
}

export function summarizeDdrrRows(rows: DdrrRow[]): DdrrSummary {
  const verdicts = countVerdicts(rows);
  const recoveryLikelihoodCorrectCount = verdicts.correct_recoverable + verdicts.correct_terminal;
  const recoveryLikelihoodScoredCount =
    verdicts.correct_recoverable +
    verdicts.correct_terminal +
    verdicts.false_terminal +
    verdicts.false_recoverable +
    verdicts.risk_noted_terminal;

  const durationRows = rows.filter((row) => row.signedErrorSec != null && row.absoluteErrorSec != null);
  const signedErrors = durationRows.map((row) => row.signedErrorSec as number);
  const absoluteErrors = durationRows.map((row) => row.absoluteErrorSec as number);
  const iqrRows = rows.filter((row) => row.withinIqr != null);
  const withinIqrCount = rows.filter((row) => row.withinIqr === true).length;

  return {
    recoveryLikelihoodCorrectCount,
    recoveryLikelihoodScoredCount,
    recoveryLikelihoodAccuracyPct:
      recoveryLikelihoodScoredCount === 0 ? null : recoveryLikelihoodCorrectCount / recoveryLikelihoodScoredCount,
    durationScoredCount: durationRows.length,
    averageSignedDurationErrorSec: mean(signedErrors),
    averageAbsoluteDurationErrorSec: mean(absoluteErrors),
    correctRecoverable: verdicts.correct_recoverable,
    correctTerminal: verdicts.correct_terminal,
    falseTerminal: verdicts.false_terminal,
    falseRecoverable: verdicts.false_recoverable,
    riskNotedTerminal: verdicts.risk_noted_terminal,
    unscoredInsufficientSignal: verdicts.unscored_insufficient_signal,
    pending: verdicts.pending,
    dataIssue: verdicts.data_issue,
    verdictScoredCount: recoveryLikelihoodScoredCount,
    durationUnscoredCount: Math.max(0, rows.length - durationRows.length),
    withinIqrCount,
    iqrScoredCount: iqrRows.length,
    withinIqrPct: iqrRows.length === 0 ? null : withinIqrCount / iqrRows.length,
    medianAbsoluteErrorSec: median(absoluteErrors),
    horizonHitRates: summarizeHorizons(rows),
  };
}
