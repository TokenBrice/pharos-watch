import { formatPercentFromRatio } from "@shared/lib/format";
import { DDR_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import type { DdrrSummary } from "@shared/types/depeg-resolver-review";

/**
 * Promoted DDRR accuracy (homepage DDR card and /depeg/ hero) with the context
 * the bare percentage hides: the always-recover baseline on the identical
 * denominator, and which frozen forecast majors the graded cohort came from.
 * Reads published aggregates only, never capped rows or the current
 * methodology envelope. Kept apart from the reviewer presentation library so
 * the homepage does not load it.
 */
export interface PromotedAccuracy {
  correct: number;
  scored: number;
  /** Null with nothing scored: a zero denominator has no percentage. */
  accuracyPct: number | null;
  /** Always-recover correct calls over the same scored cohort; null when unpublished. */
  baselineCorrect: number | null;
  baselinePct: number | null;
  /** Null when the version segments do not reconcile with the headline. */
  scope: { frozenMajors: string[]; currentMajor: string; currentScored: number } | null;
}

/** Methodology major of a version ("4.6" or "v4.6" → 4); null when unversioned. */
function parseMajor(version: string | null | undefined): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version ?? "");
  return match ? Number(match[1]) : null;
}

export function describePromotedAccuracy(summary: DdrrSummary): PromotedAccuracy {
  const { headline } = summary;
  const scored = headline.recoveryLikelihoodScoredCount;
  const correct = headline.recoveryLikelihoodCorrectCount;
  const baselineCorrect = headline.baselineRecoverableCorrectCount ?? null;
  // Fold every prediction-policy segment by major. The headline may be scoped
  // to the current policy; if other policies also scored, the totals cannot
  // reconcile and the scope is unavailable rather than misattributed.
  const scoredByMajor = new Map<number, number>();
  let unversionedScored = 0;
  for (const segment of summary.byPredictionPolicy ?? []) {
    if (segment.segmentKind !== "prediction_policy") continue;
    const count = segment.metrics.recoveryLikelihoodScoredCount;
    const major = parseMajor(segment.predictionMethodologyVersion);
    if (major == null) unversionedScored += count;
    else scoredByMajor.set(major, (scoredByMajor.get(major) ?? 0) + count);
  }
  const currentMajor = parseMajor(DDR_METHODOLOGY_VERSION);
  const versionedScored = [...scoredByMajor.values()].reduce((sum, count) => sum + count, 0);
  const scope = currentMajor == null || unversionedScored > 0 || versionedScored !== scored
    ? null
    : {
        frozenMajors: [...scoredByMajor.entries()]
          .filter(([major, count]) => major !== currentMajor && count > 0)
          .sort(([a], [b]) => a - b)
          .map(([major]) => `v${major}`),
        currentMajor: `v${currentMajor}`,
        currentScored: scoredByMajor.get(currentMajor) ?? 0,
      };
  return {
    correct,
    scored,
    accuracyPct: scored > 0 ? correct / scored : null,
    baselineCorrect,
    baselinePct: scored > 0 && baselineCorrect != null ? baselineCorrect / scored : null,
    scope,
  };
}

/** Reader lines for the promoted accuracy block, in display order. */
export function formatPromotedAccuracyLines(accuracy: PromotedAccuracy): {
  calls: string;
  baseline: string;
  /** Null when every graded call is from the current major: no qualifier needed. */
  scope: string | null;
} {
  const fraction = (count: number, pct: number | null) =>
    `${count}/${accuracy.scored}${pct == null ? "" : ` (${formatPercentFromRatio(pct, 1)})`}`;
  const { scope } = accuracy;
  return {
    calls: `Recovery calls correct: ${accuracy.correct}/${accuracy.scored}`,
    baseline: accuracy.baselineCorrect == null
      ? "Always-recover baseline: —"
      : `Always-recover baseline: ${fraction(accuracy.baselineCorrect, accuracy.baselinePct)}`,
    scope: scope == null
      ? "Graded calls by version: —"
      : scope.frozenMajors.length === 0
        ? null
        : `Graded calls from ${scope.frozenMajors.join("/")} · ${scope.currentScored} from current ${scope.currentMajor}`,
  };
}
