import type { YieldRanking, YieldRankingsResponse } from "../types/yield";
import {
  YIELD_RANKINGS_SUMMARY_PROJECTION,
  YieldRankingSummaryProvenanceSchema,
  YieldRankingSummarySchema,
  YieldRankingSummarySourceRiskSchema,
  type YieldRankingSummary,
  type YieldRankingSummaryProvenance,
  type YieldRankingSummarySourceRisk,
  type YieldRankingsSummaryResponse,
} from "../types/yield-summary";

// The summary schemas are built with `.pick()` from the detailed ones, so their
// own `.shape` keys ARE the projection field lists. Reading them here keeps the
// runtime copy and the wire schema from drifting (a hand-mirrored list silently
// drops a field the schema still admits). Zod preserves mask/extend order in
// `.shape`, so the emitted key order matches the schema declaration order.
const SUMMARY_PROVENANCE_FIELDS = Object.keys(
  YieldRankingSummaryProvenanceSchema.shape,
) as readonly (keyof YieldRankingSummaryProvenance)[];

const SUMMARY_SOURCE_RISK_FIELDS = Object.keys(
  YieldRankingSummarySourceRiskSchema.shape,
) as readonly (keyof YieldRankingSummarySourceRisk)[];

const SUMMARY_RANKING_FIELDS = Object.keys(
  YieldRankingSummarySchema.shape,
) as readonly (keyof YieldRankingSummary)[];

function projectProvenance(provenance: YieldRanking["provenance"]): YieldRankingSummaryProvenance | null | undefined {
  if (provenance == null) return provenance;
  const projected: Record<string, unknown> = {};
  for (const field of SUMMARY_PROVENANCE_FIELDS) {
    projected[field] = (provenance as Record<string, unknown>)[field];
  }
  return projected as YieldRankingSummaryProvenance;
}

function projectSourceRisk(sourceRisk: YieldRanking["sourceRisk"]): YieldRankingSummarySourceRisk | null | undefined {
  if (sourceRisk == null) return sourceRisk;
  const projected: Record<string, unknown> = {};
  for (const field of SUMMARY_SOURCE_RISK_FIELDS) {
    projected[field] = (sourceRisk as Record<string, unknown>)[field];
  }
  return projected as YieldRankingSummarySourceRisk;
}

function projectRanking(row: YieldRanking): YieldRankingSummary {
  // Summary fields that are NOT a straight copy of the same-named detail field.
  // Everything else is copied verbatim off the schema's own key list.
  const derived: Partial<Record<keyof YieldRankingSummary, unknown>> = {
    benchmarkIsFallback: row.benchmarkSelectionMode === "fallback-usd" || row.benchmarkIsFallback ? true : undefined,
    alternateSourceCount: row.altSources.length,
    decisionReasonCode: row.decisionLedger?.selectedReasonCode,
    rankDelta: row.rankChangeAttribution?.rankDelta,
    rankChangeDriver: row.rankChangeAttribution?.primaryDriver,
    rankPysDelta: row.rankChangeAttribution?.pysDelta,
    provenance: projectProvenance(row.provenance),
    sourceRisk: projectSourceRisk(row.sourceRisk),
  };

  const projected: Record<string, unknown> = {};
  for (const field of SUMMARY_RANKING_FIELDS) {
    projected[field] =
      field in derived ? derived[field] : (row as unknown as Record<string, unknown>)[field];
  }
  return projected as YieldRankingSummary;
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
