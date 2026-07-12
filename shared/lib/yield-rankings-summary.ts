import type { YieldRanking, YieldRankingsResponse } from "../types/yield";
import {
  YIELD_RANKINGS_SUMMARY_PROJECTION,
  type YieldRankingSummary,
  type YieldRankingSummaryProvenance,
  type YieldRankingSummarySourceRisk,
  type YieldRankingsSummaryResponse,
} from "../types/yield-summary";

function projectProvenance(provenance: YieldRanking["provenance"]): YieldRankingSummaryProvenance | null | undefined {
  if (provenance == null) return provenance;
  return {
    sourceKey: provenance.sourceKey,
    confidenceTier: provenance.confidenceTier,
    calculationMode: provenance.calculationMode,
    evidenceClass: provenance.evidenceClass,
    evidenceCompleteness: provenance.evidenceCompleteness,
    scoreQualification: provenance.scoreQualification,
    sourceFreshness: provenance.sourceFreshness,
    sourceSwitch: provenance.sourceSwitch,
    usedDefaultSafety: provenance.usedDefaultSafety,
    safetyProvenance: provenance.safetyProvenance,
  };
}

function projectSourceRisk(sourceRisk: YieldRanking["sourceRisk"]): YieldRankingSummarySourceRisk | null | undefined {
  if (sourceRisk == null) return sourceRisk;
  return {
    sourceRiskScore: sourceRisk.sourceRiskScore,
    sourceRiskPenalty: sourceRisk.sourceRiskPenalty,
    sourceDepthRatio: sourceRisk.sourceDepthRatio,
    rewardShare: sourceRisk.rewardShare,
    sourceAgeSeconds: sourceRisk.sourceAgeSeconds,
    observationCount30d: sourceRisk.observationCount30d,
    sourceSwitchCount30d: sourceRisk.sourceSwitchCount30d,
    venueRiskTier: sourceRisk.venueRiskTier,
    venueRiskWeighted: sourceRisk.venueRiskWeighted,
    venueRiskConfidence: sourceRisk.venueRiskConfidence,
  };
}

function projectRanking(row: YieldRanking): YieldRankingSummary {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    currentApy: row.currentApy,
    apy30d: row.apy30d,
    yieldSource: row.yieldSource,
    yieldSourceUrl: row.yieldSourceUrl,
    yieldType: row.yieldType,
    sourceTvlUsd: row.sourceTvlUsd,
    pharosYieldScore: row.pharosYieldScore,
    pysNullReason: row.pysNullReason,
    safetyScore: row.safetyScore,
    safetyGrade: row.safetyGrade,
    benchmarkKey: row.benchmarkKey,
    benchmarkLabel: row.benchmarkLabel,
    benchmarkRate: row.benchmarkRate,
    benchmarkIsFallback: row.benchmarkSelectionMode === "fallback-usd" || row.benchmarkIsFallback ? true : undefined,
    yieldStability: row.yieldStability,
    apyMin30d: row.apyMin30d,
    apyMax30d: row.apyMax30d,
    warningSignals: row.warningSignals,
    alternateSourceCount: row.altSources.length,
    decisionReasonCode: row.decisionLedger?.selectedReasonCode,
    rankDelta: row.rankChangeAttribution?.rankDelta,
    rankChangeDriver: row.rankChangeAttribution?.primaryDriver,
    rankPysDelta: row.rankChangeAttribution?.pysDelta,
    provenance: projectProvenance(row.provenance),
    sourceRisk: projectSourceRisk(row.sourceRisk),
  };
}

export function projectYieldRankingsSummary(payload: YieldRankingsResponse): YieldRankingsSummaryResponse {
  return {
    projection: YIELD_RANKINGS_SUMMARY_PROJECTION,
    rankings: payload.rankings.map(projectRanking),
    riskFreeRate: payload.riskFreeRate,
    benchmarks: payload.benchmarks,
    scalingFactor: payload.scalingFactor,
    medianApy: payload.medianApy,
    updatedAt: payload.updatedAt,
    provenance: payload.provenance,
    warnings: payload.warnings,
    publication: payload.publication,
    methodology: payload.methodology,
  };
}
