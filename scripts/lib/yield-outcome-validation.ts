import { computePYS } from "../../shared/lib/yield-scoring";
import {
  digestYieldOutcomeDataset,
  normalizeYieldOutcomeDataset,
  YIELD_OUTCOME_COHORTS,
  type YieldOutcomeCohort,
  type YieldOutcomeDataset,
  type YieldOutcomeHistoryObservation,
  type YieldOutcomeRankingObservation,
} from "./yield-outcome-validation-dataset";

const DAY_SECONDS = 86_400;
const METRIC_PRECISION = 1_000_000;
const NEUTRAL_SAFETY_SCORE = 81;

export const DEFAULT_YIELD_OUTCOME_HORIZONS_DAYS = [7, 30, 90] as const;
export const DEFAULT_YIELD_OUTCOME_MAX_GAP_HOURS = 36;
export const YIELD_OUTCOME_ABLATIONS = [
  {
    component: "benchmark",
    neutralization: "benchmarkRate=null (zero benchmark adjustment)",
  },
  {
    component: "stablecoin-safety",
    neutralization: `safetyScore=${NEUTRAL_SAFETY_SCORE} (1.0x adjusted risk denominator)`,
  },
  {
    component: "sustainability",
    neutralization: "apyVarianceScore=0 (1.0x sustainability multiplier)",
  },
  {
    component: "source-risk",
    neutralization: "sourceRiskPenalty=1 (neutral source-risk multiplier)",
  },
] as const;

export type YieldOutcomeAblationComponent = (typeof YIELD_OUTCOME_ABLATIONS)[number]["component"];

export interface YieldOutcomeValidationOptions {
  horizonDays?: readonly number[];
  maxObservationGapSeconds?: number;
}

interface RankingAnchor {
  observation: YieldOutcomeRankingObservation;
  publishedAt: number;
  methodologyVersion: string;
}

interface OutcomePair {
  anchor: RankingAnchor;
  future: YieldOutcomeHistoryObservation;
  targetAt: number;
  distanceSeconds: number;
}

interface CoverageSummary {
  rankingObservations: number;
  apyMatches: number;
  apyCoverageRate: number;
  pysEligibleRankings: number;
  pysMatches: number;
  pysCoverageRate: number;
}

interface OutcomeSummary {
  meanForwardApy30d: number | null;
  medianForwardApy30d: number | null;
  meanApyDelta: number | null;
  medianApyDelta: number | null;
  meanAbsoluteApyDelta: number | null;
  apyRetentionRate: number | null;
  meanForwardPys: number | null;
  medianForwardPys: number | null;
  meanPysDelta: number | null;
  medianPysDelta: number | null;
  meanAbsolutePysDelta: number | null;
  pysRetentionRate: number | null;
}

interface ScorePerformanceSummary {
  apySampleSize: number;
  pysSampleSize: number;
  meanAnchorPys: number | null;
  pysVsForwardApySpearman: number | null;
  pysVsForwardPysSpearman: number | null;
  topQuartileForwardApyLift: number | null;
}

export interface YieldOutcomeAblationSummary {
  component: YieldOutcomeAblationComponent;
  neutralization: string;
  sampleSize: number;
  meanScore: number | null;
  meanScoreDeltaFromBaseline: number | null;
  scoreVsForwardApySpearman: number | null;
  spearmanDeltaFromBaseline: number | null;
  scoreVsForwardPysSpearman: number | null;
  forwardPysSpearmanDeltaFromBaseline: number | null;
  topQuartileForwardApyLift: number | null;
}

interface CohortOutcomeSummary {
  cohort: YieldOutcomeCohort;
  coverage: CoverageSummary;
  outcomes: OutcomeSummary;
  scorePerformance: ScorePerformanceSummary;
}

export interface YieldOutcomeHorizonReport {
  horizonDays: number;
  targetToleranceSeconds: number;
  coverage: CoverageSummary;
  outcomes: OutcomeSummary;
  scorePerformance: ScorePerformanceSummary;
  ablations: YieldOutcomeAblationSummary[];
  cohorts: CohortOutcomeSummary[];
}

export interface YieldOutcomeValidationReport {
  schemaVersion: 1;
  dataset: {
    sha256: string;
    generationCount: number;
    rankingObservationCount: number;
    historyObservationCount: number;
    methodologyVersions: string[];
    firstPublishedAt: number;
    asOf: number;
  };
  settings: {
    horizonDays: number[];
    maxObservationGapSeconds: number;
    scoreImplementation: "shared/lib/yield-scoring.computePYS";
    formulaWeightsModified: false;
    ablations: Array<{
      component: YieldOutcomeAblationComponent;
      neutralization: string;
    }>;
  };
  recomputation: {
    eligiblePublishedScores: number;
    exactMatches: number;
    mismatchCount: number;
    meanAbsoluteDelta: number | null;
    maxAbsoluteDelta: number | null;
  };
  horizons: YieldOutcomeHorizonReport[];
}

function metric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * METRIC_PRECISION) / METRIC_PRECISION;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
    : (sorted[midpoint] ?? null);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function identityKey(stablecoinId: string, sourceKey: string): string {
  return `${stablecoinId}\0${sourceKey}`;
}

function comparePairIdentity(left: OutcomePair, right: OutcomePair): number {
  return (
    left.anchor.observation.stablecoinId.localeCompare(right.anchor.observation.stablecoinId, "en") ||
    left.anchor.observation.sourceKey.localeCompare(right.anchor.observation.sourceKey, "en") ||
    left.anchor.observation.generationId.localeCompare(right.anchor.observation.generationId, "en")
  );
}

function lowerBoundByObservedAt(observations: readonly YieldOutcomeHistoryObservation[], targetAt: number): number {
  let low = 0;
  let high = observations.length;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if ((observations[midpoint]?.observedAt ?? Infinity) < targetAt) low = midpoint + 1;
    else high = midpoint;
  }
  return low;
}

function firstAtTimestamp(
  observations: readonly YieldOutcomeHistoryObservation[],
  index: number,
): YieldOutcomeHistoryObservation | null {
  const candidate = observations[index];
  if (!candidate) return null;
  let first = index;
  while (first > 0 && observations[first - 1]?.observedAt === candidate.observedAt) first -= 1;
  return observations[first] ?? null;
}

function findNearestFutureObservation(
  observations: readonly YieldOutcomeHistoryObservation[],
  anchorPublishedAt: number,
  targetAt: number,
  maxGapSeconds: number,
): YieldOutcomeHistoryObservation | null {
  const nextIndex = lowerBoundByObservedAt(observations, targetAt);
  const candidates = [firstAtTimestamp(observations, nextIndex), firstAtTimestamp(observations, nextIndex - 1)].filter(
    (candidate): candidate is YieldOutcomeHistoryObservation => candidate != null,
  );

  return (
    candidates
      .filter(
        (candidate) =>
          candidate.observedAt > anchorPublishedAt && Math.abs(candidate.observedAt - targetAt) <= maxGapSeconds,
      )
      .sort(
        (left, right) =>
          Math.abs(left.observedAt - targetAt) - Math.abs(right.observedAt - targetAt) ||
          left.observedAt - right.observedAt ||
          left.generationId.localeCompare(right.generationId, "en"),
      )[0] ?? null
  );
}

function rankValues(values: readonly number[]): number[] {
  const indexed = values
    .map((value, index) => ({ index, value }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end]?.value === indexed[start]?.value) end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) {
      const originalIndex = indexed[index]?.index;
      if (originalIndex != null) ranks[originalIndex] = averageRank;
    }
    start = end;
  }
  return ranks;
}

function pearson(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  if (leftMean == null || rightMean == null) return null;
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = (left[index] ?? 0) - leftMean;
    const rightDelta = (right[index] ?? 0) - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator === 0 ? null : numerator / denominator;
}

export function spearmanCorrelation(left: readonly number[], right: readonly number[]): number | null {
  return metric(pearson(rankValues(left), rankValues(right)));
}

function topQuartileLift(rows: Array<{ score: number; forwardApy: number; pair: OutcomePair }>): number | null {
  if (rows.length < 2) return null;
  const sorted = [...rows].sort(
    (left, right) => right.score - left.score || comparePairIdentity(left.pair, right.pair),
  );
  const topCount = Math.max(1, Math.ceil(sorted.length * 0.25));
  const topMean = mean(sorted.slice(0, topCount).map((row) => row.forwardApy));
  const remainderMean = mean(sorted.slice(topCount).map((row) => row.forwardApy));
  return topMean == null || remainderMean == null ? null : metric(topMean - remainderMean);
}

function computePublishedScore(observation: YieldOutcomeRankingObservation): number {
  return computePYS({
    apy30d: observation.apy30d,
    safetyScore: observation.safetyScore,
    apyVarianceScore: observation.apyVarianceScore,
    benchmarkRate: observation.benchmarkRate,
    sourceRiskPenalty: observation.sourceRiskPenalty,
    scalingFactor: observation.scalingFactor,
  });
}

function computeAblatedScore(
  observation: YieldOutcomeRankingObservation,
  component: YieldOutcomeAblationComponent,
): number {
  return computePYS({
    apy30d: observation.apy30d,
    safetyScore: component === "stablecoin-safety" ? NEUTRAL_SAFETY_SCORE : observation.safetyScore,
    apyVarianceScore: component === "sustainability" ? 0 : observation.apyVarianceScore,
    benchmarkRate: component === "benchmark" ? null : observation.benchmarkRate,
    sourceRiskPenalty: component === "source-risk" ? 1 : observation.sourceRiskPenalty,
    scalingFactor: observation.scalingFactor,
  });
}

function buildCoverage(anchors: readonly RankingAnchor[], pairs: readonly OutcomePair[]): CoverageSummary {
  const pysEligibleRankings = anchors.filter((anchor) => anchor.observation.publishedPys != null).length;
  const pysMatches = pairs.filter(
    (pair) => pair.anchor.observation.publishedPys != null && pair.future.publishedPys != null,
  ).length;
  return {
    rankingObservations: anchors.length,
    apyMatches: pairs.length,
    apyCoverageRate: metric(rate(pairs.length, anchors.length)) ?? 0,
    pysEligibleRankings,
    pysMatches,
    pysCoverageRate: metric(rate(pysMatches, pysEligibleRankings)) ?? 0,
  };
}

function buildOutcomes(pairs: readonly OutcomePair[]): OutcomeSummary {
  const apyDeltas = pairs.map((pair) => pair.future.apy30d - pair.anchor.observation.apy30d);
  const pysPairs = pairs.filter(
    (pair) => pair.anchor.observation.publishedPys != null && pair.future.publishedPys != null,
  );
  const pysDeltas = pysPairs.map(
    (pair) => (pair.future.publishedPys ?? 0) - (pair.anchor.observation.publishedPys ?? 0),
  );
  return {
    meanForwardApy30d: metric(mean(pairs.map((pair) => pair.future.apy30d))),
    medianForwardApy30d: metric(median(pairs.map((pair) => pair.future.apy30d))),
    meanApyDelta: metric(mean(apyDeltas)),
    medianApyDelta: metric(median(apyDeltas)),
    meanAbsoluteApyDelta: metric(mean(apyDeltas.map(Math.abs))),
    apyRetentionRate: metric(rate(apyDeltas.filter((delta) => delta >= 0).length, apyDeltas.length)),
    meanForwardPys: metric(mean(pysPairs.map((pair) => pair.future.publishedPys ?? 0))),
    medianForwardPys: metric(median(pysPairs.map((pair) => pair.future.publishedPys ?? 0))),
    meanPysDelta: metric(mean(pysDeltas)),
    medianPysDelta: metric(median(pysDeltas)),
    meanAbsolutePysDelta: metric(mean(pysDeltas.map(Math.abs))),
    pysRetentionRate: metric(rate(pysDeltas.filter((delta) => delta >= 0).length, pysDeltas.length)),
  };
}

function buildScorePerformance(pairs: readonly OutcomePair[]): ScorePerformanceSummary {
  const apyPairs = pairs.filter((pair) => pair.anchor.observation.publishedPys != null);
  const pysPairs = apyPairs.filter((pair) => pair.future.publishedPys != null);
  return {
    apySampleSize: apyPairs.length,
    pysSampleSize: pysPairs.length,
    meanAnchorPys: metric(mean(apyPairs.map((pair) => pair.anchor.observation.publishedPys ?? 0))),
    pysVsForwardApySpearman: spearmanCorrelation(
      apyPairs.map((pair) => pair.anchor.observation.publishedPys ?? 0),
      apyPairs.map((pair) => pair.future.apy30d),
    ),
    pysVsForwardPysSpearman: spearmanCorrelation(
      pysPairs.map((pair) => pair.anchor.observation.publishedPys ?? 0),
      pysPairs.map((pair) => pair.future.publishedPys ?? 0),
    ),
    topQuartileForwardApyLift: topQuartileLift(
      apyPairs.map((pair) => ({
        score: pair.anchor.observation.publishedPys ?? 0,
        forwardApy: pair.future.apy30d,
        pair,
      })),
    ),
  };
}

function buildAblationSummary(
  pairs: readonly OutcomePair[],
  component: YieldOutcomeAblationComponent,
  neutralization: string,
): YieldOutcomeAblationSummary {
  const eligible = pairs.filter((pair) => pair.anchor.observation.publishedPys != null);
  const rows = eligible.map((pair) => ({
    pair,
    baselineScore: computePublishedScore(pair.anchor.observation),
    ablatedScore: computeAblatedScore(pair.anchor.observation, component),
  }));
  const pysRows = rows.filter((row) => row.pair.future.publishedPys != null);
  const baselineApySpearman = spearmanCorrelation(
    rows.map((row) => row.baselineScore),
    rows.map((row) => row.pair.future.apy30d),
  );
  const ablatedApySpearman = spearmanCorrelation(
    rows.map((row) => row.ablatedScore),
    rows.map((row) => row.pair.future.apy30d),
  );
  const baselinePysSpearman = spearmanCorrelation(
    pysRows.map((row) => row.baselineScore),
    pysRows.map((row) => row.pair.future.publishedPys ?? 0),
  );
  const ablatedPysSpearman = spearmanCorrelation(
    pysRows.map((row) => row.ablatedScore),
    pysRows.map((row) => row.pair.future.publishedPys ?? 0),
  );
  return {
    component,
    neutralization,
    sampleSize: rows.length,
    meanScore: metric(mean(rows.map((row) => row.ablatedScore))),
    meanScoreDeltaFromBaseline: metric(mean(rows.map((row) => row.ablatedScore - row.baselineScore))),
    scoreVsForwardApySpearman: ablatedApySpearman,
    spearmanDeltaFromBaseline:
      baselineApySpearman == null || ablatedApySpearman == null
        ? null
        : metric(ablatedApySpearman - baselineApySpearman),
    scoreVsForwardPysSpearman: ablatedPysSpearman,
    forwardPysSpearmanDeltaFromBaseline:
      baselinePysSpearman == null || ablatedPysSpearman == null
        ? null
        : metric(ablatedPysSpearman - baselinePysSpearman),
    topQuartileForwardApyLift: topQuartileLift(
      rows.map((row) => ({ score: row.ablatedScore, forwardApy: row.pair.future.apy30d, pair: row.pair })),
    ),
  };
}

function buildCohorts(anchors: readonly RankingAnchor[], pairs: readonly OutcomePair[]): CohortOutcomeSummary[] {
  return YIELD_OUTCOME_COHORTS.flatMap((cohort) => {
    const cohortAnchors = anchors.filter((anchor) => anchor.observation.cohorts.includes(cohort));
    if (cohortAnchors.length === 0) return [];
    const cohortPairs = pairs.filter((pair) => pair.anchor.observation.cohorts.includes(cohort));
    return [
      {
        cohort,
        coverage: buildCoverage(cohortAnchors, cohortPairs),
        outcomes: buildOutcomes(cohortPairs),
        scorePerformance: buildScorePerformance(cohortPairs),
      },
    ];
  });
}

function normalizeOptions(options: YieldOutcomeValidationOptions): {
  horizonDays: number[];
  maxObservationGapSeconds: number;
} {
  const horizonDays = [...(options.horizonDays ?? DEFAULT_YIELD_OUTCOME_HORIZONS_DAYS)]
    .map((value) => Number(value))
    .sort((left, right) => left - right);
  if (
    horizonDays.length === 0 ||
    horizonDays.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 365) ||
    new Set(horizonDays).size !== horizonDays.length
  ) {
    throw new Error("horizonDays must contain unique integers between 1 and 365");
  }
  const maxObservationGapSeconds = options.maxObservationGapSeconds ?? DEFAULT_YIELD_OUTCOME_MAX_GAP_HOURS * 3_600;
  if (!Number.isSafeInteger(maxObservationGapSeconds) || maxObservationGapSeconds < 1) {
    throw new Error("maxObservationGapSeconds must be a positive safe integer");
  }
  return { horizonDays, maxObservationGapSeconds };
}

export function buildYieldOutcomeValidationReport(
  input: YieldOutcomeDataset,
  options: YieldOutcomeValidationOptions = {},
): YieldOutcomeValidationReport {
  const dataset = normalizeYieldOutcomeDataset(input);
  const normalizedOptions = normalizeOptions(options);
  const generationById = new Map(dataset.generations.map((generation) => [generation.generationId, generation]));
  const anchors: RankingAnchor[] = dataset.rankingObservations.map((observation) => {
    const generation = generationById.get(observation.generationId);
    if (!generation) throw new Error(`unknown ranking generationId: ${observation.generationId}`);
    return {
      observation,
      publishedAt: generation.publishedAt,
      methodologyVersion: generation.methodologyVersion,
    };
  });
  const historyByIdentity = new Map<string, YieldOutcomeHistoryObservation[]>();
  for (const observation of dataset.historyObservations) {
    const key = identityKey(observation.stablecoinId, observation.sourceKey);
    historyByIdentity.set(key, [...(historyByIdentity.get(key) ?? []), observation]);
  }

  const publishedScoreDeltas = anchors.flatMap((anchor) =>
    anchor.observation.publishedPys == null
      ? []
      : [Math.abs(computePublishedScore(anchor.observation) - anchor.observation.publishedPys)],
  );
  const horizons = normalizedOptions.horizonDays.map((horizonDays): YieldOutcomeHorizonReport => {
    const horizonSeconds = horizonDays * DAY_SECONDS;
    const pairs = anchors.flatMap((anchor): OutcomePair[] => {
      const observations =
        historyByIdentity.get(identityKey(anchor.observation.stablecoinId, anchor.observation.sourceKey)) ?? [];
      const targetAt = anchor.publishedAt + horizonSeconds;
      const future = findNearestFutureObservation(
        observations,
        anchor.publishedAt,
        targetAt,
        normalizedOptions.maxObservationGapSeconds,
      );
      return future ? [{ anchor, future, targetAt, distanceSeconds: Math.abs(future.observedAt - targetAt) }] : [];
    });
    return {
      horizonDays,
      targetToleranceSeconds: normalizedOptions.maxObservationGapSeconds,
      coverage: buildCoverage(anchors, pairs),
      outcomes: buildOutcomes(pairs),
      scorePerformance: buildScorePerformance(pairs),
      ablations: YIELD_OUTCOME_ABLATIONS.map(({ component, neutralization }) =>
        buildAblationSummary(pairs, component, neutralization),
      ),
      cohorts: buildCohorts(anchors, pairs),
    };
  });
  const publishedTimes = dataset.generations.map((generation) => generation.publishedAt);
  const asOf = Math.max(...publishedTimes, ...dataset.historyObservations.map((observation) => observation.observedAt));
  const mismatchCount = publishedScoreDeltas.filter((delta) => delta !== 0).length;

  return {
    schemaVersion: 1,
    dataset: {
      sha256: digestYieldOutcomeDataset(dataset),
      generationCount: dataset.generations.length,
      rankingObservationCount: dataset.rankingObservations.length,
      historyObservationCount: dataset.historyObservations.length,
      methodologyVersions: [...new Set(dataset.generations.map((generation) => generation.methodologyVersion))].sort(
        (left, right) => left.localeCompare(right, "en"),
      ),
      firstPublishedAt: Math.min(...publishedTimes),
      asOf,
    },
    settings: {
      horizonDays: normalizedOptions.horizonDays,
      maxObservationGapSeconds: normalizedOptions.maxObservationGapSeconds,
      scoreImplementation: "shared/lib/yield-scoring.computePYS",
      formulaWeightsModified: false,
      ablations: YIELD_OUTCOME_ABLATIONS.map((ablation) => ({ ...ablation })),
    },
    recomputation: {
      eligiblePublishedScores: publishedScoreDeltas.length,
      exactMatches: publishedScoreDeltas.length - mismatchCount,
      mismatchCount,
      meanAbsoluteDelta: metric(mean(publishedScoreDeltas)),
      maxAbsoluteDelta: metric(publishedScoreDeltas.length > 0 ? Math.max(...publishedScoreDeltas) : null),
    },
    horizons,
  };
}
