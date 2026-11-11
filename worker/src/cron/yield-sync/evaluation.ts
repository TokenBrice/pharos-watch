import type { YieldType } from "@shared/types/yield-vocabulary";
import type {
  YieldBenchmarkKey,
  YieldBenchmarkSelectionMode,
  YieldCalculationMode,
  YieldEvidenceClass,
  YieldPysNullReason,
  YieldSafetyProvenance,
  YieldSafetyReason,
  YieldScoreQualification,
  YieldSourceRisk,
  YieldSourceInputMeta,
  YieldSourceConfidenceTier,
} from "@shared/types/yield";
import { type PysSourceRiskPenaltyReason } from "@shared/lib/yield-scoring";
import { type ParsedYieldBenchmarkMeta, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import {
  type YieldBenchmarkFreshness,
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
} from "@shared/lib/yield-benchmark-freshness";
import { type YieldSourceFreshness } from "../../lib/yield-ranking-helpers";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import type { ResolvedYield, ResolvedYieldEntry } from "./types";
import { type YieldHistorySnapshotRow } from "./history-repository";
import { detectWarningSignals } from "../yield-helpers";
import { throwIfAborted, yieldToEventLoop as defaultYieldToEventLoop } from "../../lib/abort";
import { assessYieldSourceGroup } from "./candidate-assessment";
import { selectYieldSourceGroup } from "./candidate-selection";
import { computeTvlWeightedMedianApy } from "./candidate-statistics";

export type ConfidenceTier = YieldSourceConfidenceTier;

export interface EvaluatedYieldSource {
  id: string;
  symbol: string;
  sourceKey: string;
  yieldSource: string;
  yieldType: YieldType;
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  venueProtocol?: string | null;
  venueChain?: string | null;
  sourceRisk: YieldSourceRisk | null;
  sourceRiskPenalty: number;
  sourceRiskPenaltyReason: PysSourceRiskPenaltyReason;
  sourceRiskPenaltyProvided: boolean;
  sourceRiskAdjustedUtility: number;
  dataSource: string;
  exchangeRate: number | null;
  sourceObservedAt: number | null;
  comparisonAnchorObservedAt: number | null;
  apy7d: number;
  apy30d: number;
  apyVarianceScore: number | null;
  stdDev30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
  yieldStability: number | null;
  safetyScore: number;
  safetyGrade: string;
  safetyProvenance: YieldSafetyProvenance;
  safetyReason: YieldSafetyReason | null;
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
  yieldToRisk: number | null;
  excessYield: number;
  benchmarkKey: YieldBenchmarkKey;
  benchmarkLabel: string;
  benchmarkCurrency: string;
  benchmarkRate: number;
  /**
   * Reference (USD) risk-free rate the row's hurdle was re-based onto, retained
   * so the publish-time audit snapshot can replay the score (yield v8.43, B4).
   * Null when the reference rate was unavailable.
   */
  usdBenchmarkRate: number | null;
  /** `usdBenchmarkRate - benchmarkRate` as scored; 0 when no re-base applied. */
  hurdleRebase: number;
  benchmarkRecordDate: string | null;
  benchmarkIsFallback: boolean;
  benchmarkFallbackMode: string | null;
  benchmarkSelectionMode: YieldBenchmarkSelectionMode;
  benchmarkIsProxy: boolean;
  benchmarkMeta: ParsedYieldBenchmarkMeta;
  pharosYieldScore: number | null;
  pysNullReason: YieldPysNullReason | null;
  sourceFreshness: YieldSourceFreshness;
  benchmarkFreshness: YieldBenchmarkFreshness;
  calculationMode: YieldCalculationMode;
  evidenceClass: YieldEvidenceClass;
  evidenceCompleteness: number;
  scoreQualification: YieldScoreQualification;
  scoreQualified: boolean;
  prevExchangeRate: number | null;
  prevTvlUsd: number | null;
  sourceDepthRatio: number | null;
  observationCount30d: number | null;
  sourceSwitchCount30d: number | null;
  anomalies: string[];
  warnings: string[];
  confidenceTier: ConfidenceTier;
  rejected: boolean;
  usedLegacyHistory: boolean;
  usedDefaultSafety: boolean;
  previousBestSourceKey: string | null;
}

function isResolvedYieldEntryWithYield(
  entry: ResolvedYieldEntry,
): entry is ResolvedYieldEntry & { yield: ResolvedYield } {
  return entry.yield != null;
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
  /**
   * Selected-source history rows per coin (B2/F5). When present, the published
   * `sourceSwitchCount30d` is recounted with this run's winner appended as the
   * newest publication; absent callers fall back to `sourceSwitchCount30dByCoin`
   * plus the incumbent-still-candidate increment.
   */
  bestRowsByCoin?: Map<string, YieldHistorySnapshotRow[]>;
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
  medianApy: number | null;
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

export type ResolvedYieldEntryWithYield = ResolvedYieldEntry & { yield: ResolvedYield };

export interface PreparedYieldEvaluation {
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

function prepareYieldEvaluation(input: EvaluateYieldSourcesInput): PreparedYieldEvaluation {
  // Current bootstrap/re-anchor seeds are persistence inputs, never return samples
  // or arbitration candidates. Historical seed filtering below stays independent.
  const resolvedWithYield = input.resolved.filter(isResolvedYieldEntryWithYield)
    .filter((entry) => entry.yield.observationKind !== "anchor-only");
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
  // A2: the entry's own observation age is part of its health — a frozen or
  // rewound upstream keeps returning a fresh fetch carrying an old CSV, so a
  // fetch-age-only classification would re-base rows onto a retained constant.
  const referenceBenchmarkFreshness = classifyYieldBenchmarkFreshness(input.riskFreeRates.USD, {
    recordDate: input.riskFreeRates.USD.recordDate,
    maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD,
  });
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
  const assessment = assessYieldSourceGroup(input, stablecoinId, entries, prepared);
  for (const id of assessment.defaultSafetyIds) accumulator.defaultSafetyIds.add(id);
  const selection = selectYieldSourceGroup({
    stablecoinId,
    provisional: assessment.provisional,
    previousBestSourceKey: assessment.previousBestSourceKey,
    priorSwitches30d: assessment.priorSwitches30d,
    derivedPenaltyInputByKey: assessment.derivedPenaltyInputByKey,
    bestRowsByCoin: input.bestRowsByCoin,
    safetySnapshotUnavailable: input.safetySnapshotAvailable === false,
    referenceBenchmarkFreshness: prepared.referenceBenchmarkFreshness,
    usdBenchmarkRate: prepared.usdBenchmarkRate,
  });
  if (!selection) return;

  accumulator.bestSourceKeyByCoin.set(stablecoinId, selection.bestSourceKey);
  accumulator.rowsRejected += selection.rowsRejected;
  accumulator.divergenceFlags += selection.divergenceFlags;
  accumulator.sourceSwitches += selection.sourceSwitches;
  accumulator.evaluatedSources.push(...selection.evaluatedSources);
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
