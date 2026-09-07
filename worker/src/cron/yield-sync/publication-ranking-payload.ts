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
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";
import { getComparisonAnchorStaleThresholdMs, getRankingStaleThresholdMs } from "../yield-helpers";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { compareCandidates } from "./evaluation-arbitration";
import {
  buildSelectionRankBySourceKey,
  deriveRejectionReasonCode,
  deriveYieldSourceRole,
} from "./decision-public";
import type { YieldCoinPublicationView } from "./publication-view";
import { buildYieldMethodology } from "./publication-methodology";
import { buildYieldSourceRisk } from "./source-risk";
import { classifyYieldBenchmarkFreshness } from "./benchmarks";

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
    safetyScore: source.safetyProvenance === "safety-snapshot-unavailable" ? null : source.safetyScore,
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
          safetyScoreIdentity: source.safetyScoreIdentity ?? null,
          sourceFreshness: source.sourceFreshness,
          benchmarkFreshness: source.benchmarkFreshness,
          calculationMode: source.calculationMode,
          evidenceClass: source.evidenceClass,
          evidenceCompleteness: source.evidenceCompleteness,
          scoreQualification: source.scoreQualification,
          scoreQualified: source.scoreQualified,
        }
      : null,
  };
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
    calculationMode: params.candidate.calculationMode,
    evidenceClass: params.candidate.evidenceClass,
    evidenceCompleteness: params.candidate.evidenceCompleteness,
    scoreQualification: params.candidate.scoreQualification,
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

export function buildYieldRankingsPayloadFromEvaluatedSources(
  input: {
    evaluatedSources: EvaluatedYieldSource[];
    publicationViews: Map<string, YieldCoinPublicationView>;
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
  // The publication views are the sole owner of the selection decision: each
  // view froze the winning source key when it was built, so rankings cannot
  // mix a different best-source map with the frozen decision evidence.
  const bestRows = input.evaluatedSources
    .filter((source) => input.publicationViews.get(source.id)?.selected.sourceKey === source.sourceKey)
    .sort((a, b) =>
      (b.pharosYieldScore ?? Number.NEGATIVE_INFINITY) -
      (a.pharosYieldScore ?? Number.NEGATIVE_INFINITY)
    );

  const publicationGenerationId = input.publication?.generationId ?? null;
  const rankings = bestRows.map((source, index) => {
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const view = input.publicationViews.get(source.id);
    if (view == null) {
      throw new Error(
        `yield-publication view missing for selected source ${source.id}:${source.sourceKey}`,
      );
    }
    const ranking = evaluatedSourceToRanking(
      source,
      provenance,
      publicationGenerationId,
      index + 1,
      view.decisionLedger,
    );
    const altCandidates = buildUniqueAltCandidates(source, view.candidates);
    ranking.altSources = buildAltSourcesForRanking({
      selected: source,
      candidates: view.candidates,
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
    const staleSource =
      (updatedAtMs > 0 && updatedAtMs < input.startSec * 1000 - staleThresholdMs) ||
      staleComparisonAnchor;
    const benchmarkFreshness = source.benchmarkFreshness ?? classifyYieldBenchmarkFreshness(
      source.benchmarkMeta,
      { selectionMode: source.benchmarkSelectionMode },
    );
    if (staleSource) {
      if (!ranking.warningSignals.includes("data-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
      }
      ranking.pharosYieldScore = null;
      ranking.pysNullReason = "source-stale";
    }
    if (benchmarkFreshness === "degraded" && !ranking.warningSignals.includes("benchmark-degraded")) {
      ranking.warningSignals = [...ranking.warningSignals, "benchmark-degraded"];
    }
    if (benchmarkFreshness === "stale") {
      if (!ranking.warningSignals.includes("benchmark-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "benchmark-stale"];
      }
      ranking.pharosYieldScore = null;
      ranking.pysNullReason = ranking.pysNullReason === "source-stale"
        ? ranking.pysNullReason
        : "benchmark-stale";
    }
    if (ranking.provenance) {
      const effectiveSourceFreshness = staleSource ? "stale" : (source.sourceFreshness ?? "unknown");
      const qualificationInvalidated = staleSource || benchmarkFreshness === "stale";
      const newlyMissingEvidenceFields =
        (staleSource && source.sourceFreshness === "fresh" ? 1 : 0) +
        (benchmarkFreshness === "stale" && source.benchmarkFreshness !== "stale" ? 1 : 0);
      ranking.provenance = {
        ...ranking.provenance,
        sourceFreshness: effectiveSourceFreshness,
        benchmarkFreshness,
        evidenceCompleteness: Math.max(
          0,
          Number((source.evidenceCompleteness - newlyMissingEvidenceFields / 7).toFixed(4)),
        ),
        scoreQualification: qualificationInvalidated ? "NR" : source.scoreQualification,
        scoreQualified: ranking.pharosYieldScore != null,
      };
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
