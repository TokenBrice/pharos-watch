import { assessYieldEvidence } from "@shared/lib/yield-evidence";
import { resolveYieldRowSafety } from "@shared/lib/yield-opportunity-risk";
import {
  computePYSFromComponents,
  computePysComponents,
  computePysRewardShare,
  derivePysSourceRiskPenalty,
  PYS_MAX_SOURCE_RISK_PENALTY,
  yieldStabilityToApyVarianceScore,
} from "@shared/lib/yield-scoring";
import type { PysSourceRiskPenaltyInput } from "@shared/lib/yield-scoring";
import type {
  YieldPysNullReason,
  YieldSafetyProvenance,
  YieldSafetyReason,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { DEFAULT_SAFETY_SCORE, PYS_SCALING_FACTOR } from "../../lib/constants";
import { isOnChainBootstrapYieldSeed } from "../../lib/yield-utils";
import { isRealSourceSwitch } from "../../lib/yield-history-ownership-handoffs";
import { derivePysNullReasonFromComponents } from "../../lib/yield-ranking-helpers";
import {
  classifyYieldSourceFreshness,
  getComparisonAnchorStaleThresholdMs,
  computeYieldStability,
  detectWarningSignals,
  type YieldSourceFreshness,
} from "../yield-helpers";
import type { YieldHistorySnapshotRow } from "./history";
import { computeTvlWeightedMedianApy } from "./rankings";
import type { ResolvedYield, ResolvedYieldEntry } from "./types";
import {
  classifyYieldBenchmarkFreshness,
  resolveBenchmarkForStablecoin,
  type ParsedYieldBenchmarkRegistry,
  type YieldBenchmarkFreshness,
} from "./benchmarks";
import { inferVenueProtocol, resolveDependencyConcentration } from "./source-risk";
import { buildHistoryKey, pickHistoryRowsForSource } from "./evaluation-history";
import {
  compareCandidates,
  getConfidencePriority,
  getConfidenceTier,
  relativeDivergence,
  resolveCalculationMode,
  resolveEvidenceClass,
  resolveYieldSourceLabel,
  resolveYieldTypeLabel,
} from "./evaluation-arbitration";
import type { EvaluatedYieldSource } from "./evaluation-types";
import { throwIfAborted, yieldToEventLoop as defaultYieldToEventLoop } from "../../lib/abort";

export { buildHistoryKey } from "./evaluation-history";
export { buildSelectionReason } from "./evaluation-arbitration";
export type { EvaluatedYieldSource } from "./evaluation-types";

const LOW_SOURCE_TVL_USD = 250_000;
const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;
/**
 * B3 — arbitration churn margin. `derivePysSourceRiskPenalty` charges
 * `min(0.3, sourceSwitchCount30d * 0.1)`, so the current-run `+1` used to vanish
 * from the comparison once a coin had already switched three times: stickiness
 * disappeared exactly on the coins that churn most and sub-0.1% APY noise flipped
 * the winner, which then wrote another switch. Arbitration instead charges every
 * candidate whose selection would be a real switch this flat margin — the first
 * churn increment — while the chosen row still publishes its true 30d count (and
 * the penalty derived from it).
 */
const PYS_SWITCH_ARBITRATION_MARGIN = 0.1;

function isResolvedYieldEntryWithYield(
  entry: ResolvedYieldEntry,
): entry is ResolvedYieldEntry & { yield: ResolvedYield } {
  return entry.yield != null;
}

function getHistoryRowsForStats(
  dataSource: string,
  rows: YieldHistorySnapshotRow[],
): YieldHistorySnapshotRow[] {
  if (dataSource !== "onchain") return rows;
  return rows.filter((row) => !isOnChainBootstrapYieldSeed(row));
}

export interface EvaluateYieldSourcesInput {
  resolved: ResolvedYieldEntry[];
  startSec: number;
  sevenDaysAgoSec: number;
  safetyScores: Map<string, { score: number; grade: string }>;
  /** False only when the exact published compact safety snapshot is unavailable. */
  safetySnapshotAvailable?: boolean;
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  tier1PrevRates: Map<string, number | null>;
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>;
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  prevTvlBySource: Map<string, number | null>;
  legacyPrevTvlById: Map<string, number | null>;
  prevBestSourceKeyByCoin: Map<string, string>;
  sourceSwitchCount30dByCoin?: Map<string, number>;
  stablecoinSupplyById?: Map<string, number>;
  dlPoolsMeta?: YieldSourceInputMeta;
}

export interface EvaluateYieldSourcesResult {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  defaultSafetyIds: Set<string>;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
  medianApy: number;
}

export interface EvaluateYieldSourcesProgress {
  phase: "coin-evaluation" | "warning-finalization";
  coinsDone: number;
  coinsTotal: number;
  evaluatedSources: number;
  bestSourceCoins: number;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
}

export interface EvaluateYieldSourcesCooperativeOptions {
  signal?: AbortSignal;
  yieldEveryCoins?: number;
  yieldToEventLoop?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: EvaluateYieldSourcesProgress) => void | Promise<void>;
}

type ResolvedYieldEntryWithYield = ResolvedYieldEntry & { yield: ResolvedYield };

interface PreparedYieldEvaluation {
  resolvedWithYield: ResolvedYieldEntryWithYield[];
  resolvedCountByCoin: Map<string, number>;
  resolvedByCoin: Map<string, ResolvedYieldEntryWithYield[]>;
  /** USD reference freshness for the run (A3), classified once per publication. */
  referenceBenchmarkFreshness: YieldBenchmarkFreshness;
  /** Reference rate handed to the v8.43 re-base; null when that entry is not healthy. */
  usdBenchmarkRate: number | null;
}

interface YieldEvaluationAccumulator {
  bestSourceKeyByCoin: Map<string, string>;
  evaluatedSources: EvaluatedYieldSource[];
  defaultSafetyIds: Set<string>;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
}

function computeSourceDepthRatio(sourceTvlUsd: number | null, supplyUsd: number | null | undefined): number | null {
  if (
    typeof sourceTvlUsd !== "number" ||
    !Number.isFinite(sourceTvlUsd) ||
    sourceTvlUsd < 0 ||
    typeof supplyUsd !== "number" ||
    !Number.isFinite(supplyUsd) ||
    supplyUsd <= 0
  ) {
    return null;
  }
  return sourceTvlUsd / supplyUsd;
}

function computeSourceAgeSeconds(startSec: number, sourceObservedAt: number | null | undefined): number | null {
  if (typeof sourceObservedAt !== "number" || !Number.isFinite(sourceObservedAt) || sourceObservedAt < 0) {
    return null;
  }
  return Math.max(0, Math.trunc(startSec - sourceObservedAt));
}

function isDefiLlamaDataSource(dataSource: string): boolean {
  return dataSource === "defillama" || dataSource === "defillama-auto";
}

function resolveSourceObservedAt(
  source: ResolvedYield,
  dlPoolsMeta: YieldSourceInputMeta | undefined,
): number | null {
  if (typeof source.sourceObservedAt === "number" && Number.isFinite(source.sourceObservedAt)) {
    return source.sourceObservedAt;
  }
  if (isDefiLlamaDataSource(source.dataSource)) {
    return typeof dlPoolsMeta?.updatedAt === "number" && Number.isFinite(dlPoolsMeta.updatedAt)
      ? dlPoolsMeta.updatedAt
      : null;
  }
  return null;
}

function resolveSourceAgeSeconds(
  startSec: number,
  source: ResolvedYield,
  sourceObservedAt: number | null,
  dlPoolsMeta: YieldSourceInputMeta | undefined,
): number | null {
  if (typeof source.sourceObservedAt === "number" && Number.isFinite(source.sourceObservedAt)) {
    return computeSourceAgeSeconds(startSec, sourceObservedAt);
  }
  if (
    isDefiLlamaDataSource(source.dataSource) &&
    typeof dlPoolsMeta?.ageSeconds === "number" &&
    Number.isFinite(dlPoolsMeta.ageSeconds) &&
    dlPoolsMeta.ageSeconds >= 0
  ) {
    return Math.trunc(dlPoolsMeta.ageSeconds);
  }
  return computeSourceAgeSeconds(startSec, sourceObservedAt);
}

/**
 * The null reason a row's own freshness evidence forces. Shared by the initial
 * scoring pass and the post-selection publication pass so the two cannot disagree.
 */
function resolveEvidenceNullReason(params: {
  sourceFreshness: YieldSourceFreshness;
  benchmarkFreshness: YieldBenchmarkFreshness;
  referenceBenchmarkFreshness: YieldBenchmarkFreshness;
}): YieldPysNullReason | null {
  if (params.sourceFreshness === "stale") return "source-stale";
  if (params.sourceFreshness === "unknown") return "source-freshness-unknown";
  if (params.benchmarkFreshness === "stale") return "benchmark-stale";
  // A3: a stale USD reference makes the row's re-based hurdle meaningless, so the
  // row publishes NR under the same benchmark-unavailable reason.
  if (params.referenceBenchmarkFreshness === "stale") return "benchmark-stale";
  return null;
}

/**
 * Resolve the penalty-dependent published fields from the source-risk penalty a
 * row should carry. Called twice per candidate: once with the arbitration penalty
 * (B3 switch margin, which orders the candidates) and once after selection with
 * the penalty the row actually publishes (true 30d count on the best row, no
 * switch term on alternates — B42).
 */
function resolvePenaltyDerivedFields(params: {
  apy30d: number;
  safetyScore: number;
  apyVarianceScore: number;
  benchmarkRate: number;
  benchmarkCurrency: string;
  usdBenchmarkRate: number | null;
  sourceRiskPenalty: number;
  safetySnapshotUnavailable: boolean;
  evidenceNullReason: YieldPysNullReason | null;
}): Pick<
  EvaluatedYieldSource,
  | "sourceRiskPenalty"
  | "sourceRiskPenaltyReason"
  | "sourceRiskPenaltyProvided"
  | "sourceRiskAdjustedUtility"
  | "hurdleRebase"
  | "pharosYieldScore"
  | "pysNullReason"
> {
  const components = computePysComponents({
    apy30d: params.apy30d,
    safetyScore: params.safetyScore,
    apyVarianceScore: params.apyVarianceScore,
    benchmarkRate: params.benchmarkRate,
    benchmarkCurrency: params.benchmarkCurrency,
    usdBenchmarkRate: params.usdBenchmarkRate,
    sourceRiskPenalty: params.sourceRiskPenalty,
  });
  const computedPharosYieldScore = computePYSFromComponents(params.apy30d, PYS_SCALING_FACTOR, components);
  return {
    sourceRiskPenalty: components.sourceRiskPenalty,
    sourceRiskPenaltyReason: components.sourceRiskPenaltyReason,
    sourceRiskPenaltyProvided: components.sourceRiskPenaltyProvided,
    sourceRiskAdjustedUtility: components.rowUtility,
    hurdleRebase: components.hurdleRebase,
    pharosYieldScore:
      !params.safetySnapshotUnavailable && params.evidenceNullReason == null && Number.isFinite(computedPharosYieldScore)
        ? computedPharosYieldScore
        : null,
    pysNullReason: params.safetySnapshotUnavailable
      ? "safety-unrated"
      : params.evidenceNullReason ?? (
          computedPharosYieldScore > 0
            ? null
            : derivePysNullReasonFromComponents(params.apy30d, PYS_SCALING_FACTOR, components.effectiveYield)
        ),
  };
}

function prepareYieldEvaluation(input: EvaluateYieldSourcesInput): PreparedYieldEvaluation {
  const resolvedWithYield = input.resolved.filter(isResolvedYieldEntryWithYield);
  const resolvedCountByCoin = new Map<string, number>();
  for (const entry of resolvedWithYield) {
    resolvedCountByCoin.set(entry.id, (resolvedCountByCoin.get(entry.id) ?? 0) + 1);
  }

  const resolvedByCoin = new Map<string, typeof resolvedWithYield>();
  for (const entry of resolvedWithYield) {
    const list = resolvedByCoin.get(entry.id) ?? [];
    list.push(entry);
    resolvedByCoin.set(entry.id, list);
  }

  // A3: `riskFreeRates.USD` is non-nullable even when it is a retained or
  // hardcoded fallback, so the v8.43 re-base used to consume a substituted or
  // stale constant without any row-level signal. Classify it once per run and
  // re-base only on a healthy reference; otherwise rows with a non-USD benchmark
  // publish `estimated`/NR plus a `reference-benchmark-degraded` warning.
  const referenceBenchmarkFreshness = classifyYieldBenchmarkFreshness(input.riskFreeRates.USD);
  const usdBenchmarkRate =
    referenceBenchmarkFreshness === "healthy" && Number.isFinite(input.riskFreeRates.USD.rate)
      ? input.riskFreeRates.USD.rate
      : null;

  return {
    resolvedWithYield,
    resolvedCountByCoin,
    resolvedByCoin,
    referenceBenchmarkFreshness,
    usdBenchmarkRate,
  };
}

function createEvaluationAccumulator(): YieldEvaluationAccumulator {
  return {
    bestSourceKeyByCoin: new Map<string, string>(),
    evaluatedSources: [],
    defaultSafetyIds: new Set<string>(),
    rowsRejected: 0,
    divergenceFlags: 0,
    sourceSwitches: 0,
  };
}

function evaluateYieldSourceGroup(
  input: EvaluateYieldSourcesInput,
  stablecoinId: string,
  entries: ResolvedYieldEntryWithYield[],
  prepared: PreparedYieldEvaluation,
  accumulator: YieldEvaluationAccumulator,
): void {
  const previousBestSourceKey = input.prevBestSourceKeyByCoin.get(stablecoinId) ?? null;
  const priorSwitches30d = input.sourceSwitchCount30dByCoin?.get(stablecoinId) ?? 0;
  // B2: a source missing from this run's resolved set is a fetch gap, not a
  // switch. The previous winner only carries switch weight while it is still a
  // resolvable candidate; a one-hour absence must not arm (or count) a switch.
  const previousWinnerResolved =
    previousBestSourceKey != null &&
    entries.some((entry) => entry.yield.sourceKey === previousBestSourceKey);
  // Derived penalty inputs per source key, kept so the row that wins can be re-derived
  // with its true 30d count after the arbitration role is known.
  const derivedPenaltyInputByKey = new Map<string, PysSourceRiskPenaltyInput>();

  const provisional = entries.map((entry) => {
    const y = entry.yield;
    const sourceKey = y.sourceKey;
    const yieldSource = resolveYieldSourceLabel({
      id: stablecoinId,
      dataSource: y.dataSource,
      project: y.project,
      explicitSource: y.yieldSource,
    });
    const yieldType = resolveYieldTypeLabel({
      id: stablecoinId,
      dataSource: y.dataSource,
      explicitType: y.yieldType,
    });
    const historySelection = pickHistoryRowsForSource(
      stablecoinId,
      sourceKey,
      y.dataSource,
      input.sourceHistory,
      input.onChainCompatibilityHistoryById,
      input.legacyDeterministicOnChainHistoryById,
      input.legacyHistoryById,
      prepared.resolvedCountByCoin,
      input.startSec,
    );
    const historyRows = historySelection.rows;
    const historyRowsForStats = getHistoryRowsForStats(y.dataSource, historyRows);
    const samples: number[] = [];
    const apy7dSamples: number[] = [];
    for (const row of historyRowsForStats) {
      samples.push(row.apy);
      if (row.recorded_at >= input.sevenDaysAgoSec) {
        apy7dSamples.push(row.apy);
      }
    }
    samples.push(y.currentApy);
    apy7dSamples.push(y.currentApy);

    const apy7d = apy7dSamples.reduce((sum, value) => sum + value, 0) / apy7dSamples.length;
    const apy30d = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    // B5: score the same variance the read path re-derives from the 2-dp rounded
    // `yieldStability` (computeYieldStability rounds), so the served PYS cannot
    // diverge from the published one and emit a phantom ±1 `pysDelta`.
    const yieldStability = computeYieldStability(samples);
    const apyVarianceScore = yieldStabilityToApyVarianceScore(yieldStability) ?? 0;
    const stdDev30d =
      samples.length >= 2
        ? Math.sqrt(samples.reduce((sum, value) => sum + (value - apy30d) ** 2, 0) / samples.length)
        : null;
    const apyMin30d = samples.length > 0 ? samples.reduce((min, value) => Math.min(min, value), Infinity) : null;
    const apyMax30d = samples.length > 0 ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : null;

    const safetySnapshotUnavailable = input.safetySnapshotAvailable === false;
    const safety = safetySnapshotUnavailable ? undefined : input.safetyScores.get(stablecoinId);
    if (safety == null) accumulator.defaultSafetyIds.add(stablecoinId);
    // Canonical safety-resolution ladder (yield v8.33): the same
    // `resolveYieldRowSafety` the read path runs during live-safety hydration.
    // Opportunity-level risk for external opportunities (yield v8.32): the
    // underlying stablecoin's report card is one component, not the score.
    // Royco Dawn tranches keep their bespoke market-health model and publish
    // the same contract; missing critical market evidence produces NR.
    const safetyResolution = resolveYieldRowSafety({
      yieldType,
      underlyingSafety: safety,
      defaultSafetyScore: DEFAULT_SAFETY_SCORE,
      safetySnapshotUnavailable,
      // Resolve the reviewed venue config from the same identifier stored as
      // venueProtocol (DeFiLlama project slug first, then sourceKey inference) so
      // auto-discovered lending rows — not just native/curated families — pick up
      // their 5-category venue-risk score.
      venueProtocolHint: y.project ?? inferVenueProtocol(y),
      sourceRisk: y.sourceRisk ?? null,
      sourceTvlUsd: y.sourceTvlUsd,
      ratedProvenance: "cached-publish",
    });
    const {
      underlyingSafetyGrade,
      usedDefaultSafety,
      safetyEvidenceObserved,
      opportunityEvidenceComplete,
      venueRiskWeighted: resolvedVenueRiskWeighted,
      venueRiskTier: resolvedVenueRiskTier,
    } = safetyResolution;
    const safetyScore = safetyResolution.safetyScore;
    const safetyGrade = safetyResolution.safetyGrade;
    const safetyProvenance: YieldSafetyProvenance = safetyResolution.safetyProvenance;
    const safetyReason: YieldSafetyReason | null = safetyResolution.safetyReason;
    let sourceRisk = safetyResolution.sourceRisk;
    const benchmarkSelection = resolveBenchmarkForStablecoin({
      stablecoinId,
      benchmarks: input.riskFreeRates,
      benchmarkCurrency: y.benchmarkOverrideKey ?? null,
    });
    const benchmarkMeta = benchmarkSelection.meta;
    const benchmarkRate = benchmarkMeta.rate;
    // B24: the published currency is the benchmark's own, so an alternative USD
    // benchmark (USD_EFFR) is not re-based against the USD T-bill rate.
    const benchmarkCurrency = benchmarkMeta.currency ?? benchmarkSelection.key;
    const excessYield = apy30d - benchmarkRate;
    const wouldSwitch = previousWinnerResolved && isRealSourceSwitch(previousBestSourceKey, sourceKey);
    const prevExchangeRate = input.tier1PrevRates.get(stablecoinId) ?? null;
    const prevTvlUsd = historySelection.usedLegacyHistory
      ? (input.legacyPrevTvlById.get(stablecoinId) ?? null)
      : (input.prevTvlBySource.get(buildHistoryKey(stablecoinId, sourceKey)) ?? null);
    const sourceDepthRatio = computeSourceDepthRatio(y.sourceTvlUsd, input.stablecoinSupplyById?.get(stablecoinId));
    const observationCount30d = historySelection.usedLegacyHistory
      ? null
      : new Set([
          ...historyRowsForStats.map((row) => Math.floor(row.recorded_at / DAY_SECONDS)),
          Math.floor(input.startSec / DAY_SECONDS),
        ]).size;
    // A9: the penalty input must resolve the same reward share the publisher
    // emits. A base-only payload (apyReward null while apyBase already equals the
    // current APY) proves the reward share is zero rather than unknown.
    const rewardShare =
      computePysRewardShare(y.apyReward, y.currentApy) ??
      (y.apyReward == null && y.apyBase != null && y.apyBase >= y.currentApy - 1e-9 ? 0 : null);
    const sourceObservedAt = resolveSourceObservedAt(y, input.dlPoolsMeta);
    const sourceAgeSeconds = resolveSourceAgeSeconds(input.startSec, y, sourceObservedAt, input.dlPoolsMeta);
    const comparisonAnchorAgeSeconds = computeSourceAgeSeconds(input.startSec, y.comparisonAnchorObservedAt);
    const sourceFreshness = classifyYieldSourceFreshness({
      dataSource: y.dataSource,
      sourceKey,
      sourceAgeSeconds,
      comparisonAnchorAgeSeconds,
    });
    const benchmarkFreshness = classifyYieldBenchmarkFreshness(benchmarkMeta, {
      selectionMode: benchmarkSelection.selectionMode,
    });
    // A3: only a non-USD benchmark consumes the USD reference rate, so only those
    // rows can be mis-based by a retained or stale reference; USD rows are already
    // covered by their own benchmark freshness.
    const rowReferenceBenchmarkFreshness =
      benchmarkCurrency === "USD" ? "healthy" : prepared.referenceBenchmarkFreshness;
    const referenceBenchmarkDegraded = rowReferenceBenchmarkFreshness !== "healthy";
    const calculationMode = resolveCalculationMode(y);
    const evidenceClass = resolveEvidenceClass(y);
    const evidenceAssessment = assessYieldEvidence({
      evidenceClass,
      safetyObserved: safetyEvidenceObserved,
      sourceFreshness,
      benchmarkFreshness,
      referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
      hasSourceDepth: sourceDepthRatio != null,
      hasVenueRisk: resolvedVenueRiskTier !== "unknown",
      // Distinct observation days, not raw row count: the read path can only see
      // the published `observationCount30d`, so both sides test the same fact
      // (legacy-history rows publish null and stay unqualified).
      hasHistory: (observationCount30d ?? 0) > 1,
      hasYieldDecomposition: y.apyBase != null || y.apyReward != null,
      opportunityEvidenceComplete,
    });
    const { evidenceCompleteness, scoreQualification } = evidenceAssessment;
    const effectiveScoreQualification = safetySnapshotUnavailable ? "NR" : scoreQualification;
    const scoreQualified = effectiveScoreQualification !== "NR";
    // Reviewer-set cross-venue dependency concentration (yield v8.292): resolve by
    // stablecoin id and attach it so it both penalizes PYS and surfaces on the row.
    const dependencyConcentration =
      sourceRisk?.dependencyConcentration ?? resolveDependencyConcentration(stablecoinId);
    if (dependencyConcentration && !sourceRisk?.dependencyConcentration) {
      sourceRisk = { ...(sourceRisk ?? {}), dependencyConcentration };
    }
    const derivedPenaltyInput: PysSourceRiskPenaltyInput = {
      rewardShare,
      sourceDepthRatio,
      sourceAgeSeconds,
      sourceSwitchCount30d: priorSwitches30d,
      observationCount30d,
      venueRiskTier: resolvedVenueRiskTier,
      venueRiskWeighted: resolvedVenueRiskWeighted,
      dependencyConcentrationSeverity: dependencyConcentration?.severity ?? null,
    };
    let sourceRiskPenaltyInput = sourceRisk?.sourceRiskPenalty ?? null;
    if (sourceRiskPenaltyInput == null) {
      derivedPenaltyInputByKey.set(sourceKey, derivedPenaltyInput);
      // B3: arbitration basis = pre-run count + flat switch margin (never saturated);
      // the chosen row's published penalty is re-derived below.
      sourceRiskPenaltyInput = Math.min(
        PYS_MAX_SOURCE_RISK_PENALTY,
        derivePysSourceRiskPenalty(derivedPenaltyInput) +
          (wouldSwitch ? PYS_SWITCH_ARBITRATION_MARGIN : 0),
      );
    }
    const evidenceNullReason = resolveEvidenceNullReason({
      sourceFreshness,
      benchmarkFreshness,
      referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
    });

    const penaltyDerivedFields = resolvePenaltyDerivedFields({
      apy30d,
      safetyScore,
      apyVarianceScore,
      benchmarkRate,
      benchmarkCurrency,
      // Re-base every row onto the reference (USD) risk-free rate (yield v8.43) so a
      // non-USD peg's inflation/policy-rate compensation is not scored as excess yield.
      // A3: null when the USD reference itself is degraded/stale.
      usdBenchmarkRate: prepared.usdBenchmarkRate,
      sourceRiskPenalty: sourceRiskPenaltyInput,
      safetySnapshotUnavailable,
      evidenceNullReason,
    });
    const yieldToRisk = !safetySnapshotUnavailable && 101 - safetyScore > 0 ? apy30d / (101 - safetyScore) : null;

    const anomalies: string[] = [];
    if (historySelection.usedLegacyHistory) anomalies.push("legacy-history-fallback");
    if (y.sourceTvlUsd != null && y.sourceTvlUsd < LOW_SOURCE_TVL_USD) anomalies.push("low-source-tvl");
    if (historyRows.length > 0 && apy30d > 0 && y.currentApy / apy30d > 2) anomalies.push("source-yield-spike");
    if (historyRows.length > 0 && apy30d > 0.5 && y.currentApy === 0) anomalies.push("source-zero-vs-history");
    const comparisonAnchorStaleThresholdMs = getComparisonAnchorStaleThresholdMs(y.dataSource, sourceKey);
    if (
      comparisonAnchorAgeSeconds != null &&
      comparisonAnchorAgeSeconds * 1000 > comparisonAnchorStaleThresholdMs
    ) {
      anomalies.push("anchor-stale");
    }
    if (sourceFreshness === "stale") anomalies.push("source-stale");
    if (sourceFreshness === "unknown") anomalies.push("source-freshness-unknown");
    if (!usedDefaultSafety && underlyingSafetyGrade === "NR") anomalies.push("safety-unrated");
    if (usedDefaultSafety) anomalies.push("safety-missing");
    if (benchmarkFreshness === "degraded") anomalies.push("benchmark-degraded");
    if (benchmarkFreshness === "stale") anomalies.push("benchmark-stale");

    const freshnessWarnings: string[] = [];
    if (sourceFreshness === "stale") freshnessWarnings.push("data-stale");
    if (sourceFreshness === "unknown") freshnessWarnings.push("data-freshness-unknown");
    if (!safetyEvidenceObserved) freshnessWarnings.push("safety-unrated");
    if (!opportunityEvidenceComplete) freshnessWarnings.push("opportunity-evidence-missing");
    if (benchmarkFreshness === "degraded") freshnessWarnings.push("benchmark-degraded");
    if (benchmarkFreshness === "stale") freshnessWarnings.push("benchmark-stale");
    // A3: the row's score is no longer re-based on the USD reference, so say so.
    if (referenceBenchmarkDegraded) freshnessWarnings.push("reference-benchmark-degraded");

    return {
      id: stablecoinId,
      symbol: entry.symbol,
      sourceKey,
      yieldSource,
      yieldType,
      currentApy: y.currentApy,
      apyBase: y.apyBase,
      apyReward: y.apyReward,
      sourcePool: y.sourcePool,
      sourceTvlUsd: y.sourceTvlUsd,
      venueProtocol: y.project ?? null,
      venueChain: y.chain ?? null,
      sourceRisk,
      ...penaltyDerivedFields,
      dataSource: y.dataSource,
      exchangeRate: y.exchangeRate,
      sourceObservedAt,
      comparisonAnchorObservedAt: y.comparisonAnchorObservedAt ?? null,
      apy7d,
      apy30d,
      apyVarianceScore,
      stdDev30d,
      apyMin30d,
      apyMax30d,
      yieldStability,
      safetyScore,
      safetyGrade,
      safetyProvenance,
      safetyReason,
      safetyScoreIdentity: input.safetyScoreIdentity ?? null,
      yieldToRisk,
      excessYield,
      benchmarkKey: benchmarkSelection.key,
      benchmarkLabel: benchmarkMeta.label ?? benchmarkSelection.key,
      benchmarkCurrency: benchmarkMeta.currency ?? benchmarkSelection.key,
      benchmarkRate,
      usdBenchmarkRate: prepared.usdBenchmarkRate,
      benchmarkRecordDate: benchmarkMeta.recordDate,
      benchmarkIsFallback: benchmarkMeta.isFallback,
      benchmarkFallbackMode: benchmarkMeta.fallbackMode,
      benchmarkSelectionMode: benchmarkSelection.selectionMode,
      benchmarkIsProxy: benchmarkMeta.isProxy ?? false,
      benchmarkMeta,
      sourceFreshness,
      benchmarkFreshness,
      calculationMode,
      evidenceClass,
      evidenceCompleteness,
      scoreQualification: effectiveScoreQualification,
      scoreQualified,
      prevExchangeRate,
      prevTvlUsd,
      sourceDepthRatio,
      observationCount30d,
      sourceSwitchCount30d: null,
      anomalies,
      warnings: freshnessWarnings,
      confidenceTier: getConfidenceTier(y),
      rejected: !scoreQualified,
      usedLegacyHistory: historySelection.usedLegacyHistory,
      usedDefaultSafety,
      previousBestSourceKey,
    } satisfies EvaluatedYieldSource;
  });

  let canonicalReference: EvaluatedYieldSource | undefined;
  for (const candidate of provisional) {
    if (candidate.confidenceTier === "discovered") continue;
    if (!canonicalReference || compareCandidates(candidate, canonicalReference) < 0) {
      canonicalReference = candidate;
    }
  }

  const candidates = provisional.map((candidate) => {
    const anomalies = [...candidate.anomalies];
    let rejected: boolean = candidate.rejected;

    if (
      canonicalReference &&
      canonicalReference.sourceKey !== candidate.sourceKey &&
      getConfidencePriority(candidate.confidenceTier) < getConfidencePriority(canonicalReference.confidenceTier)
    ) {
      const divergence = relativeDivergence(candidate.currentApy, canonicalReference.currentApy);
      if (canonicalReference.currentApy > 0 && candidate.currentApy > 0 && divergence > CROSS_SOURCE_DIVERGENCE_THRESHOLD) {
        anomalies.push("diverges-from-canonical");
        accumulator.divergenceFlags++;
        if (candidate.dataSource === "defillama-auto" || candidate.dataSource === "price-derived") {
          rejected = true;
        }
      }
    }

    if (
      canonicalReference &&
      canonicalReference.currentApy === 0 &&
      candidate.currentApy > 1 &&
      canonicalReference.sourceKey !== candidate.sourceKey &&
      getConfidencePriority(canonicalReference.confidenceTier) > getConfidencePriority(candidate.confidenceTier)
    ) {
      anomalies.push("canonical-zero-vs-positive");
    }

    if (anomalies.includes("source-zero-vs-history")) {
      rejected = true;
    }

    return {
      ...candidate,
      anomalies,
      rejected,
    };
  });

  const sortedCandidates = [...candidates].sort(compareCandidates);
  const rejectedPeerCount = sortedCandidates.filter((candidate) => candidate.rejected).length;
  const winner = sortedCandidates.find((candidate) => !candidate.rejected) ?? sortedCandidates[0];
  if (!winner) return;

  accumulator.bestSourceKeyByCoin.set(stablecoinId, winner.sourceKey);
  // B2: the switch only counts when the previous winner is still a publishable
  // candidate; a transient absence is recorded instead of charged.
  const winnerWouldChangeSource = isRealSourceSwitch(previousBestSourceKey, winner.sourceKey);
  const previousWinnerStillCandidate =
    previousBestSourceKey != null &&
    candidates.some((candidate) => candidate.sourceKey === previousBestSourceKey && !candidate.rejected);
  const winnerIsRealSwitch = winnerWouldChangeSource && previousWinnerStillCandidate;
  const sourceSwitchCount30d = winnerIsRealSwitch ? priorSwitches30d + 1 : priorSwitches30d;
  if (winnerIsRealSwitch) {
    accumulator.sourceSwitches++;
  }

  // Publish what the row can evidence: the best row carries the true 30d count
  // (with the +1 only when the previous winner was still a candidate) and the
  // penalty derived from it; every other row drops the switch term entirely
  // because it publishes no switch count (B42).
  const resolvePublishedPenaltyFields = (candidate: EvaluatedYieldSource, switchCount30d: number | null) => {
    const derivedPenaltyInput = derivedPenaltyInputByKey.get(candidate.sourceKey);
    return resolvePenaltyDerivedFields({
      apy30d: candidate.apy30d,
      safetyScore: candidate.safetyScore,
      apyVarianceScore: candidate.apyVarianceScore,
      benchmarkRate: candidate.benchmarkRate,
      benchmarkCurrency: candidate.benchmarkCurrency,
      usdBenchmarkRate: prepared.usdBenchmarkRate,
      sourceRiskPenalty: derivedPenaltyInput
        ? derivePysSourceRiskPenalty({ ...derivedPenaltyInput, sourceSwitchCount30d: switchCount30d })
        : candidate.sourceRiskPenalty,
      safetySnapshotUnavailable: input.safetySnapshotAvailable === false,
      evidenceNullReason: resolveEvidenceNullReason({
        sourceFreshness: candidate.sourceFreshness,
        benchmarkFreshness: candidate.benchmarkFreshness,
        referenceBenchmarkFreshness:
          candidate.benchmarkCurrency === "USD" ? "healthy" : prepared.referenceBenchmarkFreshness,
      }),
    });
  };

  accumulator.rowsRejected += rejectedPeerCount;
  accumulator.evaluatedSources.push(
    ...candidates.map((candidate) => {
      const isBest = candidate.sourceKey === winner.sourceKey;
      return {
        ...candidate,
        ...resolvePublishedPenaltyFields(candidate, isBest ? sourceSwitchCount30d : null),
        sourceSwitchCount30d: isBest ? sourceSwitchCount30d : null,
        anomalies:
          isBest && winnerWouldChangeSource && !previousWinnerStillCandidate
            ? [...candidate.anomalies, "previous-source-transiently-missing"]
            : candidate.anomalies,
      };
    }),
  );
}

function finalizeYieldEvaluation(accumulator: YieldEvaluationAccumulator): EvaluateYieldSourcesResult {
  const bestRows = accumulator.evaluatedSources.filter((source) =>
    accumulator.bestSourceKeyByCoin.get(source.id) === source.sourceKey && !source.rejected,
  );
  const medianApy = computeTvlWeightedMedianApy(
    bestRows.map((row) => ({
      apy_30d: row.apy30d,
      source_tvl_usd: row.sourceTvlUsd,
    })),
  );
  for (const source of accumulator.evaluatedSources) {
    source.warnings = [...new Set([...source.warnings, ...detectWarningSignals({
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      apyReward: source.apyReward,
      medianApy,
      sourceTvlUsd: source.sourceTvlUsd,
      prevTvlUsd: source.prevTvlUsd,
    })])];
  }

  return {
    evaluatedSources: accumulator.evaluatedSources,
    bestSourceKeyByCoin: accumulator.bestSourceKeyByCoin,
    defaultSafetyIds: accumulator.defaultSafetyIds,
    rowsRejected: accumulator.rowsRejected,
    divergenceFlags: accumulator.divergenceFlags,
    sourceSwitches: accumulator.sourceSwitches,
    medianApy,
  };
}

export function evaluateYieldSources(input: EvaluateYieldSourcesInput): EvaluateYieldSourcesResult {
  const prepared = prepareYieldEvaluation(input);
  const accumulator = createEvaluationAccumulator();
  for (const [stablecoinId, entries] of prepared.resolvedByCoin) {
    evaluateYieldSourceGroup(input, stablecoinId, entries, prepared, accumulator);
  }
  return finalizeYieldEvaluation(accumulator);
}

export async function evaluateYieldSourcesCooperative(
  input: EvaluateYieldSourcesInput,
  options: EvaluateYieldSourcesCooperativeOptions = {},
): Promise<EvaluateYieldSourcesResult> {
  const prepared = prepareYieldEvaluation(input);
  const accumulator = createEvaluationAccumulator();
  const groups = [...prepared.resolvedByCoin.entries()];
  const yieldEveryCoins = Math.max(1, options.yieldEveryCoins ?? 10);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;

  const reportProgress = async (phase: EvaluateYieldSourcesProgress["phase"], coinsDone: number) => {
    await options.onProgress?.({
      phase,
      coinsDone,
      coinsTotal: groups.length,
      evaluatedSources: accumulator.evaluatedSources.length,
      bestSourceCoins: accumulator.bestSourceKeyByCoin.size,
      rowsRejected: accumulator.rowsRejected,
      divergenceFlags: accumulator.divergenceFlags,
      sourceSwitches: accumulator.sourceSwitches,
    });
  };

  await reportProgress("coin-evaluation", 0);

  for (const [index, [stablecoinId, entries]] of groups.entries()) {
    throwIfAborted(options.signal);
    evaluateYieldSourceGroup(input, stablecoinId, entries, prepared, accumulator);
    const coinsDone = index + 1;
    if (coinsDone === groups.length || coinsDone % yieldEveryCoins === 0) {
      await reportProgress("coin-evaluation", coinsDone);
      await yieldToEventLoop(options.signal);
    }
  }

  throwIfAborted(options.signal);
  const result = finalizeYieldEvaluation(accumulator);
  await reportProgress("warning-finalization", groups.length);
  await yieldToEventLoop(options.signal);
  return result;
}
