import {
  TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins";
import { DEFAULT_SAFETY_SCORE, PYS_SCALING_FACTOR } from "../../lib/constants";
import {
  buildOnChainSourceKey,
  computeApyVarianceScore,
  computePYS,
  computeYieldStability,
} from "../yield-helpers";
import { LENDING_PROTOCOL_LABELS } from "../yield-config";
import type { YieldHistorySnapshotRow } from "./history";
import type { ResolvedYield, ResolvedYieldEntry } from "./types";

const LOW_SOURCE_TVL_USD = 250_000;
const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;
const LEGACY_HISTORY_MAX_AGE_SEC = 30 * 86400 + 5 * 86400;
const LEGACY_LUSD_BPROTOCOL_SOURCE_KEY = "bprotocol-lqty-only";
const MAX_RETAINED_RISK_FREE_RATE_AGE_SEC = 3 * 86400;

export type ConfidenceTier = "deterministic" | "curated" | "discovered" | "fallback";

export interface EvaluatedYieldSource {
  id: string;
  symbol: string;
  sourceKey: string;
  yieldSource: string;
  yieldType: string;
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  dataSource: string;
  exchangeRate: number | null;
  sourceObservedAt: number | null;
  comparisonAnchorObservedAt: number | null;
  apy7d: number;
  apy30d: number;
  apyVarianceScore: number;
  stdDev30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
  yieldStability: number | null;
  safetyScore: number;
  safetyGrade: string;
  yieldToRisk: number | null;
  excessYield: number;
  pharosYieldScore: number;
  prevExchangeRate: number | null;
  prevTvlUsd: number | null;
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

export function buildHistoryKey(stablecoinId: string, sourceKey: string): string {
  return `${stablecoinId}::${sourceKey}`;
}

export function isLegacyDeterministicOnChainSourceKey(
  stablecoinId: string,
  sourceKey: string | null | undefined,
): boolean {
  return stablecoinId === "lusd-liquity" && sourceKey === LEGACY_LUSD_BPROTOCOL_SOURCE_KEY;
}

function shouldNormalizeOnChainSourceKey(row: {
  stablecoin_id: string;
  source_key: string | null;
  data_source: string;
  exchange_rate?: number | null;
}): boolean {
  return row.data_source === "onchain"
    && (row.exchange_rate != null || isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, row.source_key));
}

function computeMedian(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return 0;
  const sorted = [...finite].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function getConfidenceTier(dataSource: string): ConfidenceTier {
  switch (dataSource) {
    case "onchain":
    case "rate-derived":
      return "deterministic";
    case "defillama":
      return "curated";
    case "defillama-auto":
      return "discovered";
    case "price-derived":
    default:
      return "fallback";
  }
}

function getConfidencePriority(tier: ConfidenceTier): number {
  switch (tier) {
    case "deterministic":
      return 4;
    case "curated":
      return 3;
    case "discovered":
      return 2;
    case "fallback":
    default:
      return 1;
  }
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

function relativeDivergence(a: number, b: number): number {
  const maxValue = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / maxValue;
}

function resolveYieldSourceLabel(params: {
  id: string;
  dataSource: string;
  project?: string;
  explicitSource?: string;
}): string {
  const meta = TRACKED_META_BY_ID.get(params.id);
  const yieldConfig = meta?.yieldConfig;
  return (
    params.explicitSource ??
    (params.dataSource === "defillama-auto" && params.project
      ? (LENDING_PROTOCOL_LABELS[params.project] ??
        params.project.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
      : (yieldConfig?.yieldSource ?? "Unknown"))
  );
}

function resolveYieldTypeLabel(params: {
  id: string;
  dataSource: string;
  explicitType?: string;
}): string {
  const meta = TRACKED_META_BY_ID.get(params.id);
  const yieldConfig = meta?.yieldConfig;
  return (
    params.explicitType ??
    (params.dataSource === "defillama-auto"
      ? "lending-opportunity"
      : (yieldConfig?.yieldType ?? "nav-appreciation"))
  );
}

function pickHistoryRowsForSource(
  stablecoinId: string,
  sourceKey: string,
  dataSource: string,
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>,
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  resolvedCountByCoin: Map<string, number>,
  startSec: number,
): { rows: YieldHistorySnapshotRow[]; usedLegacyHistory: boolean } {
  const directRows = sourceHistory.get(buildHistoryKey(stablecoinId, sourceKey)) ?? [];
  if (directRows.length > 0) {
    return { rows: directRows, usedLegacyHistory: false };
  }

  if (dataSource === "onchain" && sourceKey === buildOnChainSourceKey(stablecoinId)) {
    const compatibilityRows = onChainCompatibilityHistoryById.get(stablecoinId) ?? [];
    if (compatibilityRows.length > 0) {
      return { rows: compatibilityRows, usedLegacyHistory: false };
    }

    const legacyDeterministicRows = legacyDeterministicOnChainHistoryById.get(stablecoinId) ?? [];
    if (legacyDeterministicRows.length > 0) {
      return { rows: legacyDeterministicRows, usedLegacyHistory: false };
    }
  }

  const legacyRows = legacyHistoryById.get(stablecoinId) ?? [];
  const legacyDataSources = new Set(
    legacyRows
      .map((row) => row.data_source)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const legacyMatchesCurrentSourceFamily =
    legacyDataSources.size === 1 &&
    legacyDataSources.has(dataSource);

  const legacyCutoff = startSec - LEGACY_HISTORY_MAX_AGE_SEC;
  const freshLegacyRows = legacyRows.filter((row) => row.recorded_at >= legacyCutoff);

  if (
    freshLegacyRows.length > 0 &&
    (resolvedCountByCoin.get(stablecoinId) ?? 0) <= 1 &&
    legacyMatchesCurrentSourceFamily
  ) {
    return { rows: freshLegacyRows, usedLegacyHistory: true };
  }

  return { rows: [], usedLegacyHistory: false };
}

function compareCandidates(a: EvaluatedYieldSource, b: EvaluatedYieldSource): number {
  if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;

  const aHasPositiveApy = a.currentApy > 0;
  const bHasPositiveApy = b.currentApy > 0;
  if (aHasPositiveApy !== bHasPositiveApy) return aHasPositiveApy ? -1 : 1;

  const confidenceDiff = getConfidencePriority(b.confidenceTier) - getConfidencePriority(a.confidenceTier);
  if (confidenceDiff !== 0) return confidenceDiff;

  if (a.currentApy !== b.currentApy) return b.currentApy - a.currentApy;

  return (b.sourceTvlUsd ?? 0) - (a.sourceTvlUsd ?? 0);
}

export function buildSelectionReason(source: EvaluatedYieldSource, rejectedPeers: number): string {
  if (source.rejected) {
    return "Selected as the least-bad remaining source after arbitration penalties";
  }

  const confidenceLabel =
    source.confidenceTier === "deterministic"
      ? "deterministic"
      : source.confidenceTier === "curated"
        ? "curated canonical"
        : source.confidenceTier === "discovered"
          ? "discovered opportunity"
          : "fallback-derived";

  if (source.usedLegacyHistory) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration using legacy history carry-forward`;
  }

  if (rejectedPeers > 0) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration after rejecting ${rejectedPeers} conflicting candidate${rejectedPeers > 1 ? "s" : ""}`;
  }

  return `${confidenceLabel} source selected by confidence-weighted arbitration`;
}

export interface EvaluateYieldSourcesInput {
  resolved: ResolvedYieldEntry[];
  startSec: number;
  sevenDaysAgoSec: number;
  safetyScores: Map<string, { score: number; grade: string }>;
  riskFreeRate: number;
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

      const pharosYieldScore = computePYS({
        apy30d,
        safetyScore,
        apyVarianceScore,
        scalingFactor: PYS_SCALING_FACTOR,
      });
      const yieldToRisk = 101 - safetyScore > 0 ? apy30d / (101 - safetyScore) : null;
      const excessYield = apy30d - input.riskFreeRate;
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
  const medianApy = computeMedian(bestRows.map((row) => row.currentApy));

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

export function normalizePreviousBestSourceKey(row: {
  stablecoin_id: string;
  source_key: string | null;
  data_source: string;
  exchange_rate?: number | null;
}): string {
  return shouldNormalizeOnChainSourceKey(row)
    ? buildOnChainSourceKey(row.stablecoin_id)
    : (row.source_key ?? "legacy-best");
}
