import { DAY_SECONDS } from "@shared/lib/time-constants";
import { DEFAULT_SAFETY_SCORE, PYS_SCALING_FACTOR } from "../../lib/constants";
import { computeApyVarianceScore, computePYS, computeYieldStability } from "../yield-helpers";
import type { YieldHistorySnapshotRow } from "./history";
import { computeTvlWeightedMedianApy } from "./rankings";
import type { ResolvedYield, ResolvedYieldEntry } from "./types";
import { resolveBenchmarkForStablecoin, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { buildHistoryKey, pickHistoryRowsForSource } from "./evaluation-history";
import { compareCandidates, getConfidencePriority, getConfidenceTier, relativeDivergence, resolveYieldSourceLabel, resolveYieldTypeLabel } from "./evaluation-arbitration";
import type { EvaluatedYieldSource } from "./evaluation-types";

export { buildHistoryKey, isLegacyDeterministicOnChainSourceKey, normalizePreviousBestSourceKey } from "./evaluation-history";
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

export function evaluateYieldSources(input: EvaluateYieldSourcesInput): EvaluateYieldSourcesResult {
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

  const bestSourceKeyByCoin = new Map<string, string>();
  const evaluatedSources: EvaluatedYieldSource[] = [];
  const defaultSafetyIds = new Set<string>();
  let rowsRejected = 0;
  let divergenceFlags = 0;
  let sourceSwitches = 0;

  for (const [stablecoinId, entries] of resolvedByCoin) {
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
      const samples = historyRows.map((row) => row.apy);
      samples.push(y.currentApy);

      const apy7dSamples = historyRows
        .filter((row) => row.recorded_at >= input.sevenDaysAgoSec)
        .map((row) => row.apy);
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
      if (usedDefaultSafety) defaultSafetyIds.add(stablecoinId);
      const safetyScore = safety?.score ?? DEFAULT_SAFETY_SCORE;
      const safetyGrade = safety?.grade ?? "NR";
      const benchmarkSelection = resolveBenchmarkForStablecoin({
        stablecoinId,
        benchmarks: input.riskFreeRates,
      });
      const excessYield = apy30d - benchmarkSelection.meta.rate;

      const pharosYieldScore = computePYS({
        apy30d,
        safetyScore,
        apyVarianceScore,
        scalingFactor: PYS_SCALING_FACTOR,
        benchmarkRate: benchmarkSelection.meta.rate,
      });
      const yieldToRisk = 101 - safetyScore > 0 ? apy30d / (101 - safetyScore) : null;
      const prevExchangeRate = input.tier1PrevRates.get(stablecoinId) ?? null;
      const prevTvlUsd = historySelection.usedLegacyHistory
        ? (input.legacyPrevTvlById.get(stablecoinId) ?? null)
        : (input.prevTvlBySource.get(buildHistoryKey(stablecoinId, sourceKey)) ?? null);

      const anomalies: string[] = [];
      if (historySelection.usedLegacyHistory) anomalies.push("legacy-history-fallback");
      if (y.sourceTvlUsd != null && y.sourceTvlUsd < LOW_SOURCE_TVL_USD) anomalies.push("low-source-tvl");
      if (historyRows.length > 0 && apy30d > 0 && y.currentApy / apy30d > 2) anomalies.push("source-yield-spike");
      if (historyRows.length > 0 && apy30d > 0.5 && y.currentApy === 0) anomalies.push("source-zero-vs-history");

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
        dataSource: y.dataSource,
        exchangeRate: y.exchangeRate,
        sourceObservedAt: y.sourceObservedAt ?? null,
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
        yieldToRisk,
        excessYield,
        benchmarkKey: benchmarkSelection.key,
        benchmarkLabel: benchmarkSelection.meta.label ?? benchmarkSelection.key,
        benchmarkCurrency: benchmarkSelection.meta.currency ?? benchmarkSelection.key,
        benchmarkRate: benchmarkSelection.meta.rate,
        benchmarkRecordDate: benchmarkSelection.meta.recordDate,
        benchmarkIsFallback: benchmarkSelection.meta.isFallback,
        benchmarkFallbackMode: benchmarkSelection.meta.fallbackMode,
        benchmarkSelectionMode: benchmarkSelection.selectionMode,
        benchmarkIsProxy: benchmarkSelection.meta.isProxy ?? false,
        benchmarkMeta: benchmarkSelection.meta,
        pharosYieldScore: Number.isFinite(pharosYieldScore) ? pharosYieldScore : 0,
        prevExchangeRate,
        prevTvlUsd,
        anomalies,
        warnings: [],
        confidenceTier: getConfidenceTier(y.dataSource),
        rejected: false,
        usedLegacyHistory: historySelection.usedLegacyHistory,
        usedDefaultSafety,
        previousBestSourceKey: input.prevBestSourceKeyByCoin.get(stablecoinId) ?? null,
      } satisfies EvaluatedYieldSource;
    });

    const canonicalReference = [...provisional]
      .filter((candidate) => candidate.confidenceTier !== "discovered")
      .sort(compareCandidates)[0];

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
          divergenceFlags++;
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
    if (!winner) continue;

    bestSourceKeyByCoin.set(stablecoinId, winner.sourceKey);
    if (
      winner.previousBestSourceKey != null &&
      winner.previousBestSourceKey !== "legacy-best" &&
      winner.previousBestSourceKey !== winner.sourceKey
    ) {
      sourceSwitches++;
    }

    rowsRejected += rejectedPeerCount;
    evaluatedSources.push(
      ...candidates.map((candidate) => ({
        ...candidate,
        warnings: candidate.warnings,
        rejected: candidate.rejected,
        anomalies: candidate.anomalies,
        previousBestSourceKey: candidate.previousBestSourceKey,
        usedLegacyHistory: candidate.usedLegacyHistory,
        usedDefaultSafety: candidate.usedDefaultSafety,
        pharosYieldScore: candidate.pharosYieldScore,
      })),
    );
  }

  const bestRows = evaluatedSources.filter((source) => bestSourceKeyByCoin.get(source.id) === source.sourceKey);
  const medianApy = computeTvlWeightedMedianApy(
    bestRows.map((row) => ({
      apy_30d: row.apy30d,
      source_tvl_usd: row.sourceTvlUsd,
    })),
  );

  return {
    evaluatedSources,
    bestSourceKeyByCoin,
    defaultSafetyIds,
    rowsRejected,
    divergenceFlags,
    sourceSwitches,
    medianApy,
  };
}
