import { DAY_SECONDS } from "@shared/lib/time-constants";
import { scoreToGrade } from "@shared/lib/report-card-core";
import { computeRoycoDawnTrancheSafetyScore, isRoycoDawnTrancheSourceRisk } from "@shared/lib/royco-tranche-safety";
import {
  computePysComponents,
  computePysRewardShare,
  derivePysSourceRiskPenalty,
  deriveVenueRiskTier,
} from "@shared/lib/yield-scoring";
import type { YieldSafetyProvenance, YieldSourceInputMeta } from "@shared/types/yield";
import { DEFAULT_SAFETY_SCORE, PYS_SCALING_FACTOR } from "../../lib/constants";
import { isOnChainBootstrapYieldSeed } from "../../lib/yield-utils";
import { isRealSourceSwitch } from "../../lib/yield-history-ownership-handoffs";
import {
  COMPARISON_ANCHOR_STALE_THRESHOLD_MS,
  computeApyVarianceScore,
  computePYS,
  computeYieldStability,
  derivePysNullReason,
  detectWarningSignals,
} from "../yield-helpers";
import type { YieldHistorySnapshotRow } from "./history";
import { computeTvlWeightedMedianApy } from "./rankings";
import type { ResolvedYield, ResolvedYieldEntry } from "./types";
import { resolveBenchmarkForStablecoin, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { inferVenueProtocol, resolveDependencyConcentration, resolveReviewedYieldRiskConfig, venueRiskWeightedOf } from "./source-risk";
import { buildHistoryKey, pickHistoryRowsForSource } from "./evaluation-history";
import { compareCandidates, getConfidencePriority, getConfidenceTier, relativeDivergence, resolveYieldSourceLabel, resolveYieldTypeLabel } from "./evaluation-arbitration";
import type { EvaluatedYieldSource } from "./evaluation-types";
import { throwIfAborted, yieldToEventLoop as defaultYieldToEventLoop } from "../../lib/abort";

export { buildHistoryKey } from "./evaluation-history";
export { buildSelectionReason } from "./evaluation-arbitration";
export type { ConfidenceTier, EvaluatedYieldSource } from "./evaluation-types";

const LOW_SOURCE_TVL_USD = 250_000;
const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;
const MAX_RETAINED_RISK_FREE_RATE_AGE_SEC = 3 * DAY_SECONDS;

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

export function shouldDegradeForRiskFreeRate(meta: {
  fallbackMode: string | null;
  isFallback: boolean;
  ageSeconds: number | null;
}): boolean {
  if (!meta.fallbackMode) return false;
  if (meta.isFallback) return true;
  return meta.ageSeconds == null || meta.ageSeconds > MAX_RETAINED_RISK_FREE_RATE_AGE_SEC;
}

export interface EvaluateYieldSourcesInput {
  resolved: ResolvedYieldEntry[];
  startSec: number;
  sevenDaysAgoSec: number;
  safetyScores: Map<string, { score: number; grade: string }>;
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

  return {
    resolvedWithYield,
    resolvedCountByCoin,
    resolvedByCoin,
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
  resolvedCountByCoin: Map<string, number>,
  accumulator: YieldEvaluationAccumulator,
): void {
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
      resolvedCountByCoin,
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
    const apyVarianceScore = computeApyVarianceScore(samples) ?? 0;
    const yieldStability = computeYieldStability(samples);
    const stdDev30d =
      samples.length >= 2
        ? Math.sqrt(samples.reduce((sum, value) => sum + (value - apy30d) ** 2, 0) / samples.length)
        : null;
    const apyMin30d = samples.length > 0 ? samples.reduce((min, value) => Math.min(min, value), Infinity) : null;
    const apyMax30d = samples.length > 0 ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : null;

    const safety = input.safetyScores.get(stablecoinId);
    const usedDefaultSafety = safety == null;
    if (usedDefaultSafety) accumulator.defaultSafetyIds.add(stablecoinId);
    const underlyingSafetyScore = safety?.score ?? DEFAULT_SAFETY_SCORE;
    const underlyingSafetyGrade = safety?.grade ?? "NR";
    let safetyScore = underlyingSafetyScore;
    let safetyGrade = underlyingSafetyGrade;
    let safetyProvenance: YieldSafetyProvenance = usedDefaultSafety ? "default-safety" : "cached-publish";
    let sourceRisk = y.sourceRisk ?? null;
    if (isRoycoDawnTrancheSourceRisk(sourceRisk)) {
      const trancheSafety = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore,
        sourceRisk,
      });
      if (trancheSafety) {
        safetyScore = trancheSafety.score;
        safetyGrade = scoreToGrade(trancheSafety.score);
        safetyProvenance = "opportunity-safety";
        sourceRisk = {
          ...sourceRisk,
          underlyingSafetyScore,
          trancheSafetyScore: trancheSafety.score,
          trancheSafetyPenalty: trancheSafety.penalty,
        };
      }
    }
    const benchmarkSelection = resolveBenchmarkForStablecoin({
      stablecoinId,
      benchmarks: input.riskFreeRates,
      benchmarkCurrency: y.benchmarkOverrideKey ?? null,
    });
    const benchmarkMeta = benchmarkSelection.meta;
    const benchmarkRate = benchmarkMeta.rate;
    const excessYield = apy30d - benchmarkRate;
    const previousBestSourceKey = input.prevBestSourceKeyByCoin.get(stablecoinId) ?? null;
    const priorSwitches30d = input.sourceSwitchCount30dByCoin?.get(stablecoinId) ?? 0;
    const candidateSwitchCount30d = isRealSourceSwitch(previousBestSourceKey, sourceKey)
      ? priorSwitches30d + 1
      : priorSwitches30d;
    const prevExchangeRate = input.tier1PrevRates.get(stablecoinId) ?? null;
    const prevTvlUsd = historySelection.usedLegacyHistory
      ? (input.legacyPrevTvlById.get(stablecoinId) ?? null)
      : (input.prevTvlBySource.get(buildHistoryKey(stablecoinId, sourceKey)) ?? null);
    const sourceDepthRatio = computeSourceDepthRatio(y.sourceTvlUsd, input.stablecoinSupplyById?.get(stablecoinId));
    const observationCount30d = historySelection.usedLegacyHistory ? null : samples.length;
    const rewardShare = computePysRewardShare(y.apyReward, y.currentApy);
    const sourceObservedAt = resolveSourceObservedAt(y, input.dlPoolsMeta);
    const sourceAgeSeconds = resolveSourceAgeSeconds(input.startSec, y, sourceObservedAt, input.dlPoolsMeta);
    // Resolve the reviewed venue config from the same identifier stored as
    // venueProtocol (DeFiLlama project slug first, then sourceKey inference) so
    // auto-discovered lending rows — not just native/curated families — pick up
    // their 5-category venue-risk score.
    const reviewedRiskConfig = resolveReviewedYieldRiskConfig(
      sourceRisk?.venueProtocol ?? y.project ?? inferVenueProtocol(y),
    );
    const reviewedVenueRiskWeighted = reviewedRiskConfig
      ? venueRiskWeightedOf(reviewedRiskConfig)
      : null;
    const resolvedVenueRiskWeighted = sourceRisk?.venueRiskWeighted ?? reviewedVenueRiskWeighted;
    const resolvedVenueRiskTier =
      sourceRisk?.venueRiskTier ??
      (reviewedRiskConfig ? deriveVenueRiskTier(reviewedVenueRiskWeighted) : "unknown");
    // Reviewer-set cross-venue dependency concentration (yield v8.292): resolve by
    // stablecoin id and attach it so it both penalizes PYS and surfaces on the row.
    const dependencyConcentration =
      sourceRisk?.dependencyConcentration ?? resolveDependencyConcentration(stablecoinId);
    if (dependencyConcentration && !sourceRisk?.dependencyConcentration) {
      sourceRisk = { ...(sourceRisk ?? {}), dependencyConcentration };
    }
    const sourceRiskPenaltyInput =
      sourceRisk?.sourceRiskPenalty ??
      derivePysSourceRiskPenalty({
        rewardShare,
        sourceDepthRatio,
        sourceAgeSeconds,
        sourceSwitchCount30d: candidateSwitchCount30d,
        observationCount30d,
        venueRiskTier: resolvedVenueRiskTier,
        venueRiskWeighted: resolvedVenueRiskWeighted,
        dependencyConcentrationSeverity: dependencyConcentration?.severity ?? null,
      });
    const pysComponents = computePysComponents({
      apy30d,
      safetyScore,
      apyVarianceScore,
      benchmarkRate,
      sourceRiskPenalty: sourceRiskPenaltyInput,
    });
    const pharosYieldScore = computePYS({
      apy30d,
      safetyScore,
      apyVarianceScore,
      scalingFactor: PYS_SCALING_FACTOR,
      benchmarkRate,
      sourceRiskPenalty: sourceRiskPenaltyInput,
    });
    const pysNullReason = pharosYieldScore > 0
      ? null
      : derivePysNullReason({
          apy30d,
          safetyScore,
          apyVarianceScore,
          scalingFactor: PYS_SCALING_FACTOR,
          benchmarkRate,
          sourceRiskPenalty: sourceRiskPenaltyInput,
        });
    const yieldToRisk = 101 - safetyScore > 0 ? apy30d / (101 - safetyScore) : null;

    const comparisonAnchorAgeSeconds = computeSourceAgeSeconds(input.startSec, y.comparisonAnchorObservedAt);
    const anomalies: string[] = [];
    if (historySelection.usedLegacyHistory) anomalies.push("legacy-history-fallback");
    if (y.sourceTvlUsd != null && y.sourceTvlUsd < LOW_SOURCE_TVL_USD) anomalies.push("low-source-tvl");
    if (historyRows.length > 0 && apy30d > 0 && y.currentApy / apy30d > 2) anomalies.push("source-yield-spike");
    if (historyRows.length > 0 && apy30d > 0.5 && y.currentApy === 0) anomalies.push("source-zero-vs-history");
    if (
      comparisonAnchorAgeSeconds != null &&
      comparisonAnchorAgeSeconds * 1000 > COMPARISON_ANCHOR_STALE_THRESHOLD_MS
    ) {
      anomalies.push("anchor-stale");
    }

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
      sourceRiskPenalty: pysComponents.sourceRiskPenalty,
      sourceRiskPenaltyReason: pysComponents.sourceRiskPenaltyReason,
      sourceRiskPenaltyProvided: pysComponents.sourceRiskPenaltyProvided,
      sourceRiskAdjustedUtility: pysComponents.rowUtility,
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
      yieldToRisk,
      excessYield,
      benchmarkKey: benchmarkSelection.key,
      benchmarkLabel: benchmarkMeta.label ?? benchmarkSelection.key,
      benchmarkCurrency: benchmarkMeta.currency ?? benchmarkSelection.key,
      benchmarkRate,
      benchmarkRecordDate: benchmarkMeta.recordDate,
      benchmarkIsFallback: benchmarkMeta.isFallback,
      benchmarkFallbackMode: benchmarkMeta.fallbackMode,
      benchmarkSelectionMode: benchmarkSelection.selectionMode,
      benchmarkIsProxy: benchmarkMeta.isProxy ?? false,
      benchmarkMeta,
      pharosYieldScore: Number.isFinite(pharosYieldScore) ? pharosYieldScore : 0,
      pysNullReason,
      prevExchangeRate,
      prevTvlUsd,
      sourceDepthRatio,
      observationCount30d,
      sourceSwitchCount30d: null,
      anomalies,
      warnings: [],
      confidenceTier: getConfidenceTier(y.dataSource),
      rejected: false,
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
  const priorSwitches30d = input.sourceSwitchCount30dByCoin?.get(stablecoinId) ?? 0;
  const winnerIsRealSwitch = isRealSourceSwitch(winner.previousBestSourceKey, winner.sourceKey);
  const sourceSwitchCount30d = winnerIsRealSwitch ? priorSwitches30d + 1 : priorSwitches30d;
  if (winnerIsRealSwitch) {
    accumulator.sourceSwitches++;
  }

  accumulator.rowsRejected += rejectedPeerCount;
  accumulator.evaluatedSources.push(
    ...candidates.map((candidate) => ({
      ...candidate,
      sourceSwitchCount30d: candidate.sourceKey === winner.sourceKey ? sourceSwitchCount30d : null,
    })),
  );
}

function finalizeYieldEvaluation(accumulator: YieldEvaluationAccumulator): EvaluateYieldSourcesResult {
  const bestRows = accumulator.evaluatedSources.filter((source) =>
    accumulator.bestSourceKeyByCoin.get(source.id) === source.sourceKey,
  );
  const medianApy = computeTvlWeightedMedianApy(
    bestRows.map((row) => ({
      apy_30d: row.apy30d,
      source_tvl_usd: row.sourceTvlUsd,
    })),
  );
  for (const source of accumulator.evaluatedSources) {
    source.warnings = detectWarningSignals({
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      apyReward: source.apyReward,
      medianApy,
      sourceTvlUsd: source.sourceTvlUsd,
      prevTvlUsd: source.prevTvlUsd,
    });
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
    evaluateYieldSourceGroup(input, stablecoinId, entries, prepared.resolvedCountByCoin, accumulator);
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
    evaluateYieldSourceGroup(input, stablecoinId, entries, prepared.resolvedCountByCoin, accumulator);
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
