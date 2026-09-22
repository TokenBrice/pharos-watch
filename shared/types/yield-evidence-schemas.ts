import { z } from "zod";
import { YieldTypeSchema } from "./core";
import {
  YIELD_BENCHMARK_KEY_VALUES,
  YIELD_CALCULATION_MODE_VALUES,
  YIELD_DECISION_REASON_CODES,
  YIELD_DECISION_REJECTION_REASON_CODES,
  YIELD_DEPLOYMENT_PLACE_VALUES,
  YIELD_EVIDENCE_CLASS_VALUES,
  YIELD_OPPORTUNITY_CLASS_VALUES,
  YIELD_OPPORTUNITY_CRITICAL_EVIDENCE_VALUES,
  YIELD_RANK_CHANGE_DRIVER_VALUES,
  YIELD_SCORE_QUALIFICATION_VALUES,
  YIELD_SOURCE_CONFIDENCE_TIER_VALUES,
  YIELD_SOURCE_ROLE_VALUES,
} from "./yield-vocabulary";

export const YieldPublicationMetadataSchema = z.object({
  generationId: z.string().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
  cutoffAt: z.number().nullable().optional(),
  schemaVersion: z.number().int().positive().nullable().optional(),
  status: z.enum(["staged", "published", "failed"]).nullable().optional(),
});

export const YieldVenueRiskScoresSchema = z.object({
  audits: z.number().min(1).max(5),
  centralization: z.number().min(1).max(5),
  fundsManagement: z.number().min(1).max(5),
  liquidity: z.number().min(1).max(5),
  operational: z.number().min(1).max(5),
});

export const YieldDependencyConcentrationSchema = z.object({
  ecosystem: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  note: z.string(),
  reviewedAt: z.string(),
});


export const YieldOpportunityRiskSchema = z.object({
  opportunityClass: z.enum(YIELD_OPPORTUNITY_CLASS_VALUES),
  underlyingSafetyScore: z.number().min(0).max(100),
  opportunitySafetyScore: z.number().min(0).max(100).nullable(),
  opportunitySafetyPenalty: z.number().min(0).max(100).nullable(),
  venueReviewed: z.boolean(),
  missingCriticalEvidence: z.array(z.enum(YIELD_OPPORTUNITY_CRITICAL_EVIDENCE_VALUES)),
});
export type YieldOpportunityRisk = z.infer<typeof YieldOpportunityRiskSchema>;

export const YieldSourceRiskSchema = z.object({
  sourceRiskScore: z.number().min(0).max(100).nullable().optional(),
  sourceRiskPenalty: z.number().min(1).nullable().optional(),
  sourceDepthRatio: z.number().min(0).nullable().optional(),
  rewardShare: z.number().min(0).max(1).nullable().optional(),
  sourceAgeSeconds: z.number().int().min(0).nullable().optional(),
  observationCount30d: z.number().int().min(0).nullable().optional(),
  sourceSwitchCount30d: z.number().int().min(0).nullable().optional(),
  deploymentPlace: z.enum(YIELD_DEPLOYMENT_PLACE_VALUES).nullable().optional(),
  venueProtocol: z.string().nullable().optional(),
  venueChain: z.string().nullable().optional(),
  venueRiskTier: z.enum(["low", "medium", "high", "unknown"]).nullable().optional(),
  venueRiskScores: YieldVenueRiskScoresSchema.nullable().optional(),
  venueRiskWeighted: z.number().min(1).max(5).nullable().optional(),
  venueRiskConfidence: z.enum(["verified", "partial", "low"]).nullable().optional(),
  dependencyConcentration: YieldDependencyConcentrationSchema.nullable().optional(),
  trancheSide: z.enum(["senior", "junior"]).nullable().optional(),
  trancheSafetyScore: z.number().min(0).max(100).nullable().optional(),
  trancheSafetyPenalty: z.number().min(0).max(100).nullable().optional(),
  underlyingSafetyScore: z.number().min(0).max(100).nullable().optional(),
  marketCoverageRatio: z.number().min(0).nullable().optional(),
  marketMinCoverageRatio: z.number().min(0).nullable().optional(),
  marketUtilizationRatio: z.number().min(0).nullable().optional(),
  marketUtilizationLimitRatio: z.number().min(0).nullable().optional(),
  marketDrawdownRatio: z.number().min(0).nullable().optional(),
  marketTotalDrawdowns: z.number().int().min(0).nullable().optional(),
  marketStatus: z.enum(["normal", "protected", "unhealthy", "critical"]).nullable().optional(),
  marketTvlUsd: z.number().min(0).nullable().optional(),
  trancheTvlUsd: z.number().min(0).nullable().optional(),
  trancheShareTokenAddress: z.string().nullable().optional(),
  trancheDepositTokenAddress: z.string().nullable().optional(),
  withdrawalDelaySeconds: z.number().int().min(0).nullable().optional(),
  kycRequired: z.boolean().nullable().optional(),
  accessRestricted: z.boolean().nullable().optional(),
  investabilityFlags: z.array(z.string()).optional(),
  opportunityRisk: YieldOpportunityRiskSchema.nullable().optional(),
});
const YieldSourceRiskFieldSchemas = YieldSourceRiskSchema.shape;
type YieldSourceRiskField = keyof typeof YieldSourceRiskFieldSchemas;
const YIELD_SOURCE_RISK_FIELDS = Object.keys(YieldSourceRiskFieldSchemas) as YieldSourceRiskField[];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeYieldSourceRisk(value: unknown): YieldSourceRisk | null {
  if (!isPlainRecord(value)) return null;

  const normalized: Record<string, unknown> = {};
  for (const field of YIELD_SOURCE_RISK_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const parsed = YieldSourceRiskFieldSchemas[field].safeParse(value[field]);
    if (parsed.success && parsed.data !== undefined) {
      normalized[field] = parsed.data;
    }
  }

  if (Object.keys(normalized).length === 0) return null;
  const parsed = YieldSourceRiskSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

/**
 * Written `pys_inputs_at_publish` schema version. v2 adds the v8.43 hurdle
 * re-base inputs (`usdBenchmarkRate`, `hurdleRebase`); v1 snapshots stay readable
 * so the read side can still replay pre-v8.43 rows.
 */
export const YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION = 2;

export const YieldPysInputsAtPublishSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION)]),
  methodologyVersion: z.string().min(1),
  apy30d: z.number(),
  safetyScore: z.number(),
  varianceScore: z.number(),
  benchmarkRate: z.number(),
  sourceRiskPenalty: z.number().min(1),
  scalingFactor: z.number().positive(),
  scoreQualification: z.enum(YIELD_SCORE_QUALIFICATION_VALUES),
  benchmarkKey: z.enum(YIELD_BENCHMARK_KEY_VALUES),
  evidenceClass: z.enum(YIELD_EVIDENCE_CLASS_VALUES),
  /** Reference (USD) risk-free rate the row's hurdle was re-based onto (v8.43+). */
  usdBenchmarkRate: z.number().optional(),
  /** `usdBenchmarkRate - benchmarkRate` as scored, or 0 when no re-base applied. */
  hurdleRebase: z.number().optional(),
});
export type YieldPysInputsAtPublish = z.infer<typeof YieldPysInputsAtPublishSchema>;

export const YieldHistoryPointSchema = z.object({
  date: z.union([z.number(), z.string()]),
  apy: z.number(),
  apyBase: z.number().nullable(),
  apyReward: z.number().nullable(),
  exchangeRate: z.number().nullable(),
  sourceTvlUsd: z.number().nullable(),
  warningSignals: z.array(z.string()),
  sourceKey: z.string().nullable().optional(),
  yieldSource: z.string().nullable().optional(),
  yieldSourceUrl: z.string().url().nullable().optional(),
  yieldType: YieldTypeSchema.nullable().optional(),
  dataSource: z.string().nullable().optional(),
  isBest: z.boolean().optional(),
  sourceSwitch: z.boolean().optional(),
  publicationGenerationId: z.string().nullable().optional(),
  sourceRisk: YieldSourceRiskSchema.nullable().optional(),
  pysAtPublish: z.number().nullable().optional(),
  safetyAtPublish: z.number().nullable().optional(),
  varianceAtPublish: z.number().nullable().optional(),
  pysInputsAtPublish: YieldPysInputsAtPublishSchema.nullable().optional(),
  /**
   * Derived by replaying `computePYS` from the stored inputs: `exact` reproduces
   * `pysAtPublish`, `not-scored` is a row the publisher left NR (its snapshot
   * exists but no number was published to reproduce), `legacy-partial` is a
   * pre-v8.43 snapshot whose missing re-base inputs cannot be verified for a
   * non-USD benchmark, `invalid` is a current-producer defect (no stored input
   * set reproduces the row).
   */
  pysReproducibility: z.enum(["exact", "not-scored", "legacy-partial", "invalid"]).optional(),
});

export const YieldPublicDecisionAlternativeSchema = z.object({
  sourceKey: z.string(),
  yieldSource: z.string(),
  apy30dDelta: z.number(),
  rejectionReasonCode: z.enum(YIELD_DECISION_REJECTION_REASON_CODES),
  confidenceTier: z.enum(YIELD_SOURCE_CONFIDENCE_TIER_VALUES).optional(),
  calculationMode: z.enum(YIELD_CALCULATION_MODE_VALUES).optional(),
  evidenceClass: z.enum(YIELD_EVIDENCE_CLASS_VALUES).optional(),
  evidenceCompleteness: z.number().min(0).max(1).nullable().optional(),
  scoreQualification: z.enum(YIELD_SCORE_QUALIFICATION_VALUES).optional(),
  sourceRole: z.enum(YIELD_SOURCE_ROLE_VALUES).optional(),
  selectionRank: z.number().int().positive().optional(),
});

export const YieldPublicDecisionLedgerSchema = z.object({
  selectedReasonCode: z.enum(YIELD_DECISION_REASON_CODES),
  previousBestSourceKey: z.string().nullable().optional(),
  sourceSwitch: z.boolean(),
  apy30dDeltaFromPrevious: z.number().nullable().optional(),
  rejectedCount: z.number().int().min(0),
  alternatives: z.array(YieldPublicDecisionAlternativeSchema).max(2),
});

export const YieldRankChangeAttributionSchema = z.object({
  previousRank: z.number().int().positive().nullable().optional(),
  rankDelta: z.number().int().nullable().optional(),
  previousPys: z.number().nullable().optional(),
  pysDelta: z.number().nullable().optional(),
  primaryDriver: z.enum(YIELD_RANK_CHANGE_DRIVER_VALUES).nullable().optional(),
  driverContributions: z
    .object({
      apy: z.number().nullable().optional(),
      benchmark: z.number().nullable().optional(),
      stablecoinSafety: z.number().nullable().optional(),
      sourceRisk: z.number().nullable().optional(),
      sourceSwitch: z.number().nullable().optional(),
      freshness: z.number().nullable().optional(),
      volatility: z.number().nullable().optional(),
      tvlDepth: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const YieldRankChangeAttributionFieldSchemas = YieldRankChangeAttributionSchema.shape;
type YieldRankChangeAttributionField = keyof typeof YieldRankChangeAttributionFieldSchemas;
const YIELD_RANK_CHANGE_ATTRIBUTION_FIELDS = Object.keys(
  YieldRankChangeAttributionFieldSchemas,
) as YieldRankChangeAttributionField[];

export function normalizeYieldRankChangeAttribution(value: unknown): YieldRankChangeAttribution | null {
  if (!isPlainRecord(value)) return null;

  const normalized: Record<string, unknown> = {};
  for (const field of YIELD_RANK_CHANGE_ATTRIBUTION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const parsed = YieldRankChangeAttributionFieldSchemas[field].safeParse(value[field]);
    if (parsed.success && parsed.data !== undefined) {
      normalized[field] = parsed.data;
    }
  }

  if (Object.keys(normalized).length === 0) return null;
  const parsed = YieldRankChangeAttributionSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

export type YieldHistoryPoint = z.infer<typeof YieldHistoryPointSchema>;
export type YieldPublicationMetadata = z.infer<typeof YieldPublicationMetadataSchema>;
export type YieldSourceRisk = z.infer<typeof YieldSourceRiskSchema>;
export type YieldVenueRiskScoresPayload = z.infer<typeof YieldVenueRiskScoresSchema>;
export type YieldDependencyConcentration = z.infer<typeof YieldDependencyConcentrationSchema>;
export type YieldPublicDecisionAlternative = z.infer<typeof YieldPublicDecisionAlternativeSchema>;
export type YieldPublicDecisionLedger = z.infer<typeof YieldPublicDecisionLedgerSchema>;
export type YieldRankChangeAttribution = z.infer<typeof YieldRankChangeAttributionSchema>;
