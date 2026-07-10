import type {
  AltYieldSource,
  YieldAlternateSummary,
  YieldAlternateSourceSummary,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldPublicDecisionLedger,
  YieldPublicationMetadata,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { PYS_SCALING_FACTOR } from "../../lib/constants";
import {
  isRealSourceSwitch,
  LEGACY_BEST_YIELD_SOURCE_KEY,
} from "../../lib/yield-history-ownership-handoffs";
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";
import { getComparisonAnchorStaleThresholdMs, getRankingStaleThresholdMs } from "../yield-helpers";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { compareCandidates } from "./evaluation-arbitration";
import {
  buildPublicDecisionLedger,
  deriveRejectionReasonCode,
  deriveYieldSourceRole,
} from "./decision-public";
import { buildYieldMethodology } from "./publication-methodology";
import { buildYieldSourceRisk } from "./source-risk";

function evaluatedSourceToRanking(
  source: EvaluatedYieldSource,
  provenance: Record<string, unknown> | null,
  publicationGenerationId?: string | null,
  publishedRank?: number,
  decisionLedger?: YieldPublicDecisionLedger | null,
) {
  const meta = TRACKED_META_BY_ID.get(source.id);
  return {
    id: source.id,
    symbol: source.symbol,
    name: meta?.name ?? source.symbol,
    currentApy: source.currentApy,
    apy7d: source.apy7d,
    apy30d: source.apy30d,
    apyBase: source.apyBase,
    apyReward: source.apyReward,
    yieldSource: source.yieldSource,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId: source.id,
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    }),
    yieldType: source.yieldType,
    dataSource: source.dataSource,
    sourceTvlUsd: source.sourceTvlUsd,
    pharosYieldScore: source.pharosYieldScore,
    pysNullReason: source.pysNullReason,
    safetyScore: source.safetyScore,
    safetyGrade: source.safetyGrade,
    safetyReason: source.safetyReason,
    yieldToRisk: source.yieldToRisk,
    excessYield: source.excessYield,
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    benchmarkRate: source.benchmarkRate,
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    yieldStability: source.yieldStability,
    apyVariance30d: source.stdDev30d,
    apyMin30d: source.apyMin30d,
    apyMax30d: source.apyMax30d,
    warningSignals: [...source.warnings],
    altSources: [] as AltYieldSource[],
    alternateSummary: undefined as YieldAlternateSummary | null | undefined,
    sourceRisk: buildYieldSourceRisk({ source, provenance, isBest: true }),
    sourceRole: deriveYieldSourceRole(source, { isSelected: true }),
    ...(publicationGenerationId ? { publicationGenerationId } : {}),
    ...(publishedRank ? { publishedRank } : {}),
    ...(decisionLedger ? { decisionLedger } : {}),
    provenance: provenance
      ? {
          ...provenance,
          safetyProvenance: source.safetyProvenance,
          safetyReason: source.safetyReason,
        }
      : null,
  };
}

function buildSelectionRankBySourceKey(candidates: EvaluatedYieldSource[]): Map<string, number> {
  const selectionRankBySourceKey = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    if (!selectionRankBySourceKey.has(candidate.sourceKey)) {
      selectionRankBySourceKey.set(candidate.sourceKey, index + 1);
    }
  });
  return selectionRankBySourceKey;
}

function buildAltYieldSource(params: {
  selected: EvaluatedYieldSource;
  candidate: EvaluatedYieldSource;
  provenance: Record<string, unknown> | null;
  selectionRank: number | undefined;
}): AltYieldSource {
  return {
    sourceKey: params.candidate.sourceKey,
    yieldSource: params.candidate.yieldSource,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId: params.candidate.id,
      sourceKey: params.candidate.sourceKey,
      yieldSource: params.candidate.yieldSource,
    }),
    yieldType: params.candidate.yieldType as AltYieldSource["yieldType"],
    currentApy: params.candidate.currentApy,
    apy30d: params.candidate.apy30d,
    sourceTvlUsd: params.candidate.sourceTvlUsd,
    dataSource: params.candidate.dataSource,
    sourceRisk: buildYieldSourceRisk({
      source: params.candidate,
      provenance: params.provenance,
      isBest: false,
    }),
    sourceRole: deriveYieldSourceRole(params.candidate, { isSelected: false }),
    confidenceTier: params.candidate.confidenceTier,
    selectionRank: params.selectionRank,
    rejectionReasonCode: deriveRejectionReasonCode(params.selected, params.candidate),
  };
}

function buildAltSourcesForRanking(params: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  rankingProvenanceByKey: Map<string, Record<string, unknown>>;
}): AltYieldSource[] {
  const selectionRankBySourceKey = buildSelectionRankBySourceKey(params.candidates);
  const alts: AltYieldSource[] = [];
  for (const candidate of buildUniqueAltCandidates(params.selected, params.candidates)) {
    const key = buildHistoryKey(candidate.id, candidate.sourceKey);
    const provenance = params.rankingProvenanceByKey.get(key) ?? null;
    alts.push(
      buildAltYieldSource({
        selected: params.selected,
        candidate,
        provenance,
        selectionRank: selectionRankBySourceKey.get(candidate.sourceKey),
      }),
    );
  }
  return alts;
}

function buildUniqueAltCandidates(
  selected: EvaluatedYieldSource,
  candidates: EvaluatedYieldSource[],
): EvaluatedYieldSource[] {
  const bySourceKey = new Map<string, EvaluatedYieldSource>();
  for (const candidate of candidates) {
    if (candidate.sourceKey === selected.sourceKey) {
      continue;
    }
    const existing = bySourceKey.get(candidate.sourceKey);
    if (!existing || candidate.currentApy > existing.currentApy) {
      bySourceKey.set(candidate.sourceKey, candidate);
    }
  }
  return [...bySourceKey.values()];
}

function toAlternateSourceSummary(
  selected: EvaluatedYieldSource,
  candidate: EvaluatedYieldSource,
): YieldAlternateSourceSummary {
  const sourceRiskPenalty = Number.isFinite(candidate.sourceRiskPenalty)
    ? candidate.sourceRiskPenalty
    : null;
  const riskAdjustedUtility = Number.isFinite(candidate.sourceRiskAdjustedUtility)
    ? candidate.sourceRiskAdjustedUtility
    : null;
  return {
    sourceKey: candidate.sourceKey,
    yieldSource: candidate.yieldSource,
    yieldType: candidate.yieldType,
    dataSource: candidate.dataSource,
    currentApy: candidate.currentApy,
    apy30d: candidate.apy30d,
    apy30dDelta: candidate.apy30d - selected.apy30d,
    sourceTvlUsd: candidate.sourceTvlUsd,
    confidenceTier: candidate.confidenceTier,
    sourceRole: deriveYieldSourceRole(candidate, { isSelected: false }),
    sourceRiskPenalty,
    riskAdjustedUtility,
  };
}

function buildAlternateSummary(
  selected: EvaluatedYieldSource,
  altCandidates: EvaluatedYieldSource[],
): YieldAlternateSummary | null {
  if (altCandidates.length === 0) return null;
  const bestAlternateByApy = [...altCandidates].sort((a, b) => {
    if (b.apy30d !== a.apy30d) return b.apy30d - a.apy30d;
    return compareCandidates(a, b);
  })[0];
  const bestRiskAdjustedAlternate = [...altCandidates].sort((a, b) => {
    const utilityDiff = b.sourceRiskAdjustedUtility - a.sourceRiskAdjustedUtility;
    if (utilityDiff !== 0) return utilityDiff;
    return compareCandidates(a, b);
  })[0];
  return {
    count: altCandidates.length,
    bestAlternateByApy: bestAlternateByApy
      ? toAlternateSourceSummary(selected, bestAlternateByApy)
      : null,
    bestRiskAdjustedAlternate: bestRiskAdjustedAlternate
      ? toAlternateSourceSummary(selected, bestRiskAdjustedAlternate)
      : null,
    alternateApySpread: bestAlternateByApy ? bestAlternateByApy.apy30d - selected.apy30d : null,
  };
}

export function resolveApy30dDeltaFromPrevious(input: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  previousBestSourceKey: string | null;
}): number | null {
  if (!isRealSourceSwitch(input.previousBestSourceKey, input.selected.sourceKey)) {
    return null;
  }

  const previous = input.candidates.find(
    (candidate) => candidate.sourceKey === input.previousBestSourceKey,
  );
  if (!previous || !Number.isFinite(previous.apy30d) || !Number.isFinite(input.selected.apy30d)) {
    return null;
  }
  return input.selected.apy30d - previous.apy30d;
}

export function buildYieldRankingsPayloadFromEvaluatedSources(
  input: {
    evaluatedSources: EvaluatedYieldSource[];
    bestSourceKeyByCoin: Map<string, string>;
    rankingProvenanceByKey: Map<string, Record<string, unknown>>;
    riskFreeRate: number;
    riskFreeRateMeta: YieldBenchmarkMeta;
    riskFreeRateRegistry?: YieldBenchmarkRegistry;
    dlPoolsMeta: YieldSourceInputMeta;
    safetySnapshot: YieldSafetySnapshotMeta;
    medianApy: number;
    startSec: number;
    publication?: YieldPublicationMetadata | null;
  },
) {
  const bestRows = input.evaluatedSources
    .filter((source) => input.bestSourceKeyByCoin.get(source.id) === source.sourceKey)
    .sort((a, b) => b.pharosYieldScore - a.pharosYieldScore);

  const publicationGenerationId = input.publication?.generationId ?? null;
  const rankings = bestRows.map((source, index) => {
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const candidates = input.evaluatedSources
      .filter((candidate) => candidate.id === source.id)
      .sort(compareCandidates);
    const rejectedCount = candidates.filter((candidate) => candidate.rejected).length;
    const previousBestSourceKey =
      source.previousBestSourceKey != null &&
      source.previousBestSourceKey !== LEGACY_BEST_YIELD_SOURCE_KEY
        ? source.previousBestSourceKey
        : null;
    const sourceSwitch = isRealSourceSwitch(previousBestSourceKey, source.sourceKey);
    const apy30dDeltaFromPrevious = resolveApy30dDeltaFromPrevious({
      selected: source,
      candidates,
      previousBestSourceKey,
    });
    const decisionLedger = buildPublicDecisionLedger({
      selected: source,
      candidates,
      rejectedCount,
      previousBestSourceKey,
      sourceSwitch,
      apy30dDeltaFromPrevious,
    });
    const ranking = evaluatedSourceToRanking(
      source,
      provenance,
      publicationGenerationId,
      index + 1,
      decisionLedger,
    );
    const altCandidates = buildUniqueAltCandidates(source, candidates);
    ranking.altSources = buildAltSourcesForRanking({
      selected: source,
      candidates,
      rankingProvenanceByKey: input.rankingProvenanceByKey,
    });
    const alternateSummary = buildAlternateSummary(source, altCandidates);
    if (alternateSummary) {
      ranking.alternateSummary = alternateSummary;
    }

    const sourceObservedAt =
      provenance != null && typeof provenance.sourceObservedAt === "number"
        ? provenance.sourceObservedAt
        : input.startSec;
    const updatedAtMs = sourceObservedAt * 1000;
    const staleThresholdMs = getRankingStaleThresholdMs(source.dataSource, source.sourceKey);
    const comparisonAnchorAgeSeconds =
      provenance != null && typeof provenance.comparisonAnchorAgeSeconds === "number"
        ? provenance.comparisonAnchorAgeSeconds
        : null;
    const staleComparisonAnchor =
      comparisonAnchorAgeSeconds != null &&
      comparisonAnchorAgeSeconds * 1000 > getComparisonAnchorStaleThresholdMs(source.dataSource, source.sourceKey);
    if ((updatedAtMs > 0 && updatedAtMs < Date.now() - staleThresholdMs) || staleComparisonAnchor) {
      if (!ranking.warningSignals.includes("data-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
      }
    }
    ranking.sourceRole = deriveYieldSourceRole(
      { ...source, warnings: ranking.warningSignals },
      { isSelected: true },
    );

    return ranking;
  });

  return {
    rankings,
    riskFreeRate: input.riskFreeRate,
    benchmarks: input.riskFreeRateRegistry,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: input.medianApy,
    updatedAt: input.startSec,
    methodology: buildYieldMethodology(input.startSec),
    ...(input.publication ? { publication: input.publication } : {}),
    provenance: {
      selectionMethod: "confidence-weighted" as const,
      benchmark: input.riskFreeRateMeta,
      benchmarks: input.riskFreeRateRegistry,
      dlPools: input.dlPoolsMeta,
      safetySnapshot: input.safetySnapshot,
    },
  };
}
