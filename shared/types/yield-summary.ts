import { z } from "zod";
import { YieldRankingsResponseSchema } from "./yield";

export const YIELD_RANKINGS_SUMMARY_PROJECTION = "summary" as const;

const DetailedYieldRankingSchema = YieldRankingsResponseSchema.shape.rankings.element;
const DetailedYieldRankingProvenanceSchema = DetailedYieldRankingSchema.shape.provenance.unwrap().unwrap();
const DetailedYieldSourceRiskSchema = DetailedYieldRankingSchema.shape.sourceRisk.unwrap().unwrap();

export const YieldRankingSummaryProvenanceSchema = DetailedYieldRankingProvenanceSchema.pick({
  confidenceTier: true,
  calculationMode: true,
  evidenceClass: true,
  evidenceCompleteness: true,
  scoreQualification: true,
  sourceSwitch: true,
  usedDefaultSafety: true,
  safetyProvenance: true,
}).strict();

export const YieldRankingSummarySourceRiskSchema = DetailedYieldSourceRiskSchema.pick({
  sourceRiskScore: true,
  sourceRiskPenalty: true,
  sourceDepthRatio: true,
  rewardShare: true,
  sourceAgeSeconds: true,
  observationCount30d: true,
  sourceSwitchCount30d: true,
  venueRiskTier: true,
  venueRiskWeighted: true,
  venueRiskConfidence: true,
}).strict();

export const YieldRankingSummarySchema = DetailedYieldRankingSchema.pick({
  id: true,
  symbol: true,
  name: true,
  currentApy: true,
  apy30d: true,
  yieldSource: true,
  yieldSourceUrl: true,
  yieldType: true,
  sourceTvlUsd: true,
  pharosYieldScore: true,
  pysNullReason: true,
  safetyScore: true,
  safetyGrade: true,
  excessYield: true,
  benchmarkKey: true,
  benchmarkLabel: true,
  benchmarkRate: true,
  benchmarkIsFallback: true,
  benchmarkSelectionMode: true,
  yieldStability: true,
  apyMin30d: true,
  apyMax30d: true,
  warningSignals: true,
})
  .extend({
    alternateSourceCount: z.number().int().nonnegative(),
    provenance: YieldRankingSummaryProvenanceSchema.nullable().optional(),
    sourceRisk: YieldRankingSummarySourceRiskSchema.nullable().optional(),
  })
  .strict();

const YieldSummaryFreshnessMetaSchema = z
  .object({
    updatedAt: z.number(),
    ageSeconds: z.number(),
    status: z.enum(["fresh", "degraded", "stale"]),
  })
  .strict();

export const YieldRankingsSummaryResponseSchema = YieldRankingsResponseSchema.omit({
  rankings: true,
})
  .extend({
    projection: z.literal(YIELD_RANKINGS_SUMMARY_PROJECTION),
    rankings: z.array(YieldRankingSummarySchema),
    _meta: YieldSummaryFreshnessMetaSchema.optional(),
  })
  .strict();

export type YieldRankingSummaryProvenance = z.infer<typeof YieldRankingSummaryProvenanceSchema>;
export type YieldRankingSummarySourceRisk = z.infer<typeof YieldRankingSummarySourceRiskSchema>;
export type YieldRankingSummary = z.infer<typeof YieldRankingSummarySchema>;
export type YieldRankingsSummaryResponse = z.infer<typeof YieldRankingsSummaryResponseSchema>;
