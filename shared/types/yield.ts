import { z } from "zod";
import { isRecord } from "../lib/type-guards";
import { MethodologyEnvelopeSchema, YieldTypeSchema } from "./core";
import { ReportCardGradeSchema } from "./report-cards";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";

export const YIELD_ADAPTER_LIFECYCLE_VALUES = ["active", "quarantined", "intentional-gap", "experimental"] as const;
export type YieldAdapterLifecycle = (typeof YIELD_ADAPTER_LIFECYCLE_VALUES)[number];

export interface YieldAdapterLifecycleReason {
  /** Canonical short code such as "convert-to-assets-empty" or "no-public-yield-source". */
  code: string;
  /** ISO date (YYYY-MM-DD) the entry entered this lifecycle state. */
  since: string;
  /** Optional ISO date by which an operator should re-review the entry. */
  nextReviewAt?: string;
  /** Optional URL to docs, runbook, or evidence. */
  evidenceUrl?: string;
  /** Short free-form note (legacy rationale text lives here). */
  note?: string;
}

export const YIELD_BENCHMARK_KEY_VALUES = [
  "USD",
  "USD_EFFR",
  "EUR",
  "CHF",
  "GBP",
  "JPY",
  "MXN",
  "BRL",
  "AUD",
  "CAD",
  "RUB",
  "TRY",
  "SGD",
] as const;
export type YieldBenchmarkKey = (typeof YIELD_BENCHMARK_KEY_VALUES)[number];
export const YIELD_PYS_NULL_REASONS = [
  "apy-non-positive",
  "effective-yield-non-positive",
  "scaling-invalid",
  "missing-inputs",
  "source-stale",
  "source-freshness-unknown",
  "benchmark-stale",
  "safety-unrated",
  "opportunity-evidence-missing",
] as const;
export type YieldPysNullReason = (typeof YIELD_PYS_NULL_REASONS)[number];
export type YieldBenchmarkSelectionMode = "native" | "fallback-usd" | "manual-override";
export type YieldSafetyProvenance =
  | "live-report-card"
  | "cached-publish"
  | "default-safety"
  | "opportunity-safety"
  | "safety-snapshot-unavailable";
export const YIELD_SAFETY_REASON_VALUES = [
  "report-card-score-missing",
  "report-card-grade-not-rated",
  "underlying-report-card-score-missing",
  "safety-snapshot-unavailable",
  "safety-identity-missing",
  "safety-identity-mismatch",
] as const;
export type YieldSafetyReason = (typeof YIELD_SAFETY_REASON_VALUES)[number];
export type YieldVenueRiskTier = "low" | "medium" | "high" | "unknown";
export type YieldTrancheSide = "senior" | "junior";
export type YieldMarketStatus = "normal" | "protected" | "unhealthy" | "critical";
export const YIELD_SOURCE_CONFIDENCE_TIER_VALUES = ["deterministic", "curated", "discovered", "fallback"] as const;
export type YieldSourceConfidenceTier = (typeof YIELD_SOURCE_CONFIDENCE_TIER_VALUES)[number];
export const YIELD_CALCULATION_MODE_VALUES = [
  "direct-read",
  "exchange-rate-math",
  "market-api",
  "benchmark-model",
  "price-return",
] as const;
export type YieldCalculationMode = (typeof YIELD_CALCULATION_MODE_VALUES)[number];
export const YIELD_EVIDENCE_CLASS_VALUES = [
  "direct-first-party",
  "direct-onchain",
  "curated-observation",
  "discovered-observation",
  "modeled-proxy",
  "fallback",
] as const;
export type YieldEvidenceClass = (typeof YIELD_EVIDENCE_CLASS_VALUES)[number];
export const YIELD_SCORE_QUALIFICATION_VALUES = ["rated", "estimated", "partial", "NR"] as const;
export type YieldScoreQualification = (typeof YIELD_SCORE_QUALIFICATION_VALUES)[number];
export const YIELD_SOURCE_ROLE_VALUES = [
  "canonical-holder",
  "external-opportunity",
  "fallback-proxy",
  "audit-alternate",
  "degraded-canonical",
] as const;
export type YieldSourceRole = (typeof YIELD_SOURCE_ROLE_VALUES)[number];
export const YIELD_DEPLOYMENT_PLACE_VALUES = [
  "native-wrapper",
  "issuer-savings",
  "lending-market",
  "strategy-vault",
  "structured-tranche",
  "lp-or-dex",
  "rwa-fund",
  "reward-program",
  "rate-derived",
  "price-derived",
] as const;
export type YieldDeploymentPlace = (typeof YIELD_DEPLOYMENT_PLACE_VALUES)[number];
const YIELD_RANK_CHANGE_DRIVER_VALUES = [
  "apy",
  "benchmark",
  "stablecoin-safety",
  "source-risk",
  "source-switch",
  "freshness",
  "volatility",
  "tvl-depth",
] as const;
export type YieldRankChangeDriver = (typeof YIELD_RANK_CHANGE_DRIVER_VALUES)[number];

export const YIELD_DECISION_REASON_CODES = [
  "best-by-confidence-and-apy",
  "deterministic-preferred",
  "curated-over-discovered",
  "tier-preference",
  "tvl-floor",
  "freshness-tiebreaker",
  "fallback",
  "no-alternatives",
] as const;
export type YieldDecisionReasonCode = (typeof YIELD_DECISION_REASON_CODES)[number];

export const YIELD_DECISION_REJECTION_REASON_CODES = [
  "thinner",
  "stale",
  "lower-confidence",
  "rewards-only",
  "smaller",
  "unspecified",
] as const;
export type YieldDecisionRejectionReasonCode = (typeof YIELD_DECISION_REJECTION_REASON_CODES)[number];

const YieldPublicationMetadataSchema = z.object({
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

export const YIELD_OPPORTUNITY_CLASS_VALUES = ["lending", "fixed-yield", "structured-tranche"] as const;
export type YieldOpportunityClass = (typeof YIELD_OPPORTUNITY_CLASS_VALUES)[number];

export const YIELD_OPPORTUNITY_CRITICAL_EVIDENCE_VALUES = ["venue-review", "market-size", "market-status"] as const;
export type YieldOpportunityCriticalEvidence = (typeof YIELD_OPPORTUNITY_CRITICAL_EVIDENCE_VALUES)[number];

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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeYieldSourceRisk(value: unknown): YieldSourceRisk | null {
  if (!isRecord(value)) return null;

  const normalized: Record<string, unknown> = {};
  for (const field of YIELD_SOURCE_RISK_FIELDS) {
    if (!hasOwn(value, field)) continue;
    const parsed = YieldSourceRiskFieldSchemas[field].safeParse(value[field]);
    if (parsed.success && parsed.data !== undefined) {
      normalized[field] = parsed.data;
    }
  }

  if (Object.keys(normalized).length === 0) return null;
  const parsed = YieldSourceRiskSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

export const YieldPysInputsAtPublishSchema = z.object({
  schemaVersion: z.literal(1),
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
});
export type YieldPysInputsAtPublish = z.infer<typeof YieldPysInputsAtPublishSchema>;

const YieldHistoryPointSchema = z.object({
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
  pysReproducibility: z.enum(["exact", "legacy-partial"]).optional(),
});

const YieldPublicDecisionAlternativeSchema = z.object({
  sourceKey: z.string(),
  yieldSource: z.string(),
  apy30dDelta: z.number(),
  rejectionReasonCode: z.enum(YIELD_DECISION_REJECTION_REASON_CODES),
  confidenceTier: z.enum(YIELD_SOURCE_CONFIDENCE_TIER_VALUES).optional(),
  calculationMode: z.enum(YIELD_CALCULATION_MODE_VALUES).optional(),
  evidenceClass: z.enum(YIELD_EVIDENCE_CLASS_VALUES).optional(),
  evidenceCompleteness: z.number().min(0).max(1).optional(),
  scoreQualification: z.enum(YIELD_SCORE_QUALIFICATION_VALUES).optional(),
  sourceRole: z.enum(YIELD_SOURCE_ROLE_VALUES).optional(),
  selectionRank: z.number().int().positive().optional(),
});

const YieldPublicDecisionLedgerSchema = z.object({
  selectedReasonCode: z.enum(YIELD_DECISION_REASON_CODES),
  previousBestSourceKey: z.string().nullable().optional(),
  sourceSwitch: z.boolean(),
  apy30dDeltaFromPrevious: z.number().nullable().optional(),
  rejectedCount: z.number().int().min(0),
  alternatives: z.array(YieldPublicDecisionAlternativeSchema).max(2),
});

const YieldRankChangeAttributionSchema = z.object({
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

const AltYieldSourceSchema = z.object({
  sourceKey: z.string(),
  yieldSource: z.string(),
  yieldSourceUrl: z.string().url().nullable().optional(),
  yieldType: YieldTypeSchema,
  currentApy: z.number(),
  apy30d: z.number(),
  sourceTvlUsd: z.number().nullable(),
  dataSource: z.string(),
  sourceRisk: YieldSourceRiskSchema.nullable().optional(),
  sourceRole: z.enum(YIELD_SOURCE_ROLE_VALUES).optional(),
  confidenceTier: z.enum(YIELD_SOURCE_CONFIDENCE_TIER_VALUES).optional(),
  calculationMode: z.enum(YIELD_CALCULATION_MODE_VALUES).optional(),
  evidenceClass: z.enum(YIELD_EVIDENCE_CLASS_VALUES).optional(),
  evidenceCompleteness: z.number().min(0).max(1).optional(),
  scoreQualification: z.enum(YIELD_SCORE_QUALIFICATION_VALUES).optional(),
  selectionRank: z.number().int().positive().optional(),
  rejectionReasonCode: z.enum(YIELD_DECISION_REJECTION_REASON_CODES).optional(),
});

const YieldAlternateSourceSummarySchema = z.object({
  sourceKey: z.string(),
  yieldSource: z.string(),
  yieldType: YieldTypeSchema,
  dataSource: z.string(),
  currentApy: z.number(),
  apy30d: z.number(),
  apy30dDelta: z.number(),
  sourceTvlUsd: z.number().nullable(),
  confidenceTier: z.enum(YIELD_SOURCE_CONFIDENCE_TIER_VALUES).optional(),
  sourceRole: z.enum(YIELD_SOURCE_ROLE_VALUES).optional(),
  sourceRiskPenalty: z.number().min(1).nullable().optional(),
  riskAdjustedUtility: z.number().nullable().optional(),
});

const YieldAlternateSummarySchema = z.object({
  count: z.number().int().min(0),
  bestAlternateByApy: YieldAlternateSourceSummarySchema.nullable(),
  bestRiskAdjustedAlternate: YieldAlternateSourceSummarySchema.nullable(),
  alternateApySpread: z.number().nullable(),
});

const YieldBenchmarkMetaSchema = z.object({
  key: z.enum(YIELD_BENCHMARK_KEY_VALUES).optional(),
  label: z.string().optional(),
  currency: z.string().optional(),
  rate: z.number(),
  recordDate: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  source: z.string(),
  isFallback: z.boolean(),
  fallbackMode: z.string().nullable(),
  isProxy: z.boolean().optional(),
});

const YieldBenchmarkRegistrySchema = z.object({
  USD: YieldBenchmarkMetaSchema,
  USD_EFFR: YieldBenchmarkMetaSchema.nullable().optional(),
  EUR: YieldBenchmarkMetaSchema.nullable().optional(),
  CHF: YieldBenchmarkMetaSchema.nullable().optional(),
  GBP: YieldBenchmarkMetaSchema.nullable().optional(),
  JPY: YieldBenchmarkMetaSchema.nullable().optional(),
  MXN: YieldBenchmarkMetaSchema.nullable().optional(),
  BRL: YieldBenchmarkMetaSchema.nullable().optional(),
  AUD: YieldBenchmarkMetaSchema.nullable().optional(),
  CAD: YieldBenchmarkMetaSchema.nullable().optional(),
  RUB: YieldBenchmarkMetaSchema.nullable().optional(),
  TRY: YieldBenchmarkMetaSchema.nullable().optional(),
  SGD: YieldBenchmarkMetaSchema.nullable().optional(),
});

const YieldSourceInputMetaSchema = z.object({
  mode: z.enum(["dex-cache", "direct-fetch", "unavailable"]),
  updatedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  poolCount: z.number(),
  fallbackMode: z.string().nullable(),
});

const YieldSafetySnapshotMetaSchema = z.object({
  kind: z.enum(["ok", "degraded"]),
  coverageRatio: z.number(),
  coveredCount: z.number(),
  trackedCount: z.number(),
  reason: z.string().nullable(),
  // The retired cache label remains accepted only for persisted pre-V9 payloads.
  source: z.enum(["safety-score-v9-publication", "report-card-cache"]).optional(),
  expectedModel: z.literal("v9").optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  publicationGenerationId: z.string().nullable().optional(),
  methodologyVersion: z.string().nullable().optional(),
  publishedAt: z.number().nullable().optional(),
});

const YieldLiveSafetyHydrationMetaSchema = z.object({
  kind: z.enum(["ok", "degraded"]),
  coverageRatio: z.number(),
  coveredCount: z.number(),
  trackedCount: z.number(),
  reason: z.string().nullable(),
  // Non-V9 labels are historical readers, not live source choices.
  source: z.enum(["safety-score-v9-publication", "report-card-cache", "report-cards:snapshot", "computed-report-cards"]),
  expectedModel: z.literal("v9").optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  publicationGenerationId: z.string().nullable(),
  methodologyVersion: z.string().nullable(),
  publishedAt: z.number().nullable(),
});

const YieldRankingProvenanceSchema = z.object({
  sourceKey: z.string(),
  sourceObservedAt: z.number(),
  sourceAgeSeconds: z.number(),
  comparisonAnchorObservedAt: z.number().nullable().optional(),
  comparisonAnchorAgeSeconds: z.number().nullable().optional(),
  confidenceTier: z.enum(["deterministic", "curated", "discovered", "fallback"]),
  calculationMode: z.enum(YIELD_CALCULATION_MODE_VALUES).optional(),
  evidenceClass: z.enum(YIELD_EVIDENCE_CLASS_VALUES).optional(),
  evidenceCompleteness: z.number().min(0).max(1).optional(),
  scoreQualification: z.enum(YIELD_SCORE_QUALIFICATION_VALUES).optional(),
  selectionMethod: z.literal("confidence-weighted"),
  selectionReason: z.string(),
  sourceSwitch: z.boolean(),
  previousBestSourceKey: z.string().nullable(),
  usedLegacyHistory: z.boolean(),
  usedDefaultSafety: z.boolean(),
  safetyProvenance: z.enum([
    "live-report-card",
    "cached-publish",
    "default-safety",
    "opportunity-safety",
    "safety-snapshot-unavailable",
  ]).optional(),
  safetyReason: z.enum(YIELD_SAFETY_REASON_VALUES).nullable().optional(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  benchmarkKey: z.enum(YIELD_BENCHMARK_KEY_VALUES).optional(),
  benchmarkLabel: z.string().optional(),
  benchmarkCurrency: z.string().optional(),
  benchmarkRate: z.number().optional(),
  benchmarkRecordDate: z.string().nullable(),
  benchmarkIsFallback: z.boolean(),
  benchmarkFallbackMode: z.string().nullable(),
  benchmarkSelectionMode: z.enum(["native", "fallback-usd", "manual-override"]).optional(),
  benchmarkIsProxy: z.boolean().optional(),
  sourceFreshness: z.enum(["fresh", "stale", "unknown"]).optional(),
  benchmarkFreshness: z.enum(["healthy", "degraded", "stale"]).optional(),
  scoreQualified: z.boolean().optional(),
  anomalies: z.array(z.string()),
});

const YieldRankingsProvenanceSchema = z.object({
  selectionMethod: z.literal("confidence-weighted"),
  benchmark: YieldBenchmarkMetaSchema,
  benchmarks: YieldBenchmarkRegistrySchema.optional(),
  dlPools: YieldSourceInputMetaSchema,
  safetySnapshot: YieldSafetySnapshotMetaSchema,
  liveSafetyHydration: YieldLiveSafetyHydrationMetaSchema.optional(),
});

export type YieldHistoryPoint = z.infer<typeof YieldHistoryPointSchema>;
export type YieldPublicationMetadata = z.infer<typeof YieldPublicationMetadataSchema>;
export type YieldSourceRisk = z.infer<typeof YieldSourceRiskSchema>;
export type YieldVenueRiskScoresPayload = z.infer<typeof YieldVenueRiskScoresSchema>;
export type YieldDependencyConcentration = z.infer<typeof YieldDependencyConcentrationSchema>;
export type YieldPublicDecisionAlternative = z.infer<typeof YieldPublicDecisionAlternativeSchema>;
export type YieldPublicDecisionLedger = z.infer<typeof YieldPublicDecisionLedgerSchema>;
export type YieldRankChangeAttribution = z.infer<typeof YieldRankChangeAttributionSchema>;
export type AltYieldSource = z.infer<typeof AltYieldSourceSchema>;
export type YieldAlternateSourceSummary = z.infer<typeof YieldAlternateSourceSummarySchema>;
export type YieldAlternateSummary = z.infer<typeof YieldAlternateSummarySchema>;
export type YieldBenchmarkMeta = z.infer<typeof YieldBenchmarkMetaSchema>;
export type YieldBenchmarkRegistry = z.infer<typeof YieldBenchmarkRegistrySchema>;
export type YieldSourceInputMeta = z.infer<typeof YieldSourceInputMetaSchema>;
export type YieldSafetySnapshotMeta = z.infer<typeof YieldSafetySnapshotMetaSchema>;
export type YieldRankingProvenance = z.infer<typeof YieldRankingProvenanceSchema>;

const YieldRankingSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  currentApy: z.number(),
  apy7d: z.number(),
  apy30d: z.number(),
  apyBase: z.number().nullable(),
  apyReward: z.number().nullable(),
  yieldSource: z.string(),
  yieldSourceUrl: z.string().url().nullable().optional(),
  yieldType: YieldTypeSchema,
  dataSource: z.string(),
  sourceTvlUsd: z.number().nullable(),
  pharosYieldScore: z.number().nullable(),
  pysNullReason: z.enum(YIELD_PYS_NULL_REASONS).nullable().optional(),
  safetyScore: z.number().nullable(),
  safetyGrade: ReportCardGradeSchema.nullable(),
  safetyReason: z.enum(YIELD_SAFETY_REASON_VALUES).nullable().optional(),
  yieldToRisk: z.number().nullable(),
  excessYield: z.number().nullable(),
  benchmarkKey: z.enum(YIELD_BENCHMARK_KEY_VALUES).optional(),
  benchmarkLabel: z.string().optional(),
  benchmarkCurrency: z.string().optional(),
  benchmarkRate: z.number().optional(),
  benchmarkRecordDate: z.string().nullable().optional(),
  benchmarkIsFallback: z.boolean().optional(),
  benchmarkFallbackMode: z.string().nullable().optional(),
  benchmarkSelectionMode: z.enum(["native", "fallback-usd", "manual-override"]).optional(),
  benchmarkIsProxy: z.boolean().optional(),
  yieldStability: z.number().nullable(),
  apyVariance30d: z.number().nullable(),
  apyMin30d: z.number().nullable(),
  apyMax30d: z.number().nullable(),
  warningSignals: z.array(z.string()),
  altSources: z.array(AltYieldSourceSchema).optional().default([]),
  alternateSummary: YieldAlternateSummarySchema.nullable().optional(),
  provenance: YieldRankingProvenanceSchema.nullable().optional(),
  publicationGenerationId: z.string().nullable().optional(),
  publishedRank: z.number().int().positive().nullable().optional(),
  liveRank: z.number().int().positive().nullable().optional(),
  sourceRisk: YieldSourceRiskSchema.nullable().optional(),
  sourceRole: z.enum(YIELD_SOURCE_ROLE_VALUES).optional(),
  rankChangeAttribution: YieldRankChangeAttributionSchema.nullable().optional(),
  decisionLedger: YieldPublicDecisionLedgerSchema.nullable().optional(),
});
export type YieldRanking = z.infer<typeof YieldRankingSchema>;

const YieldResponseWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  reasons: z.array(z.string()).optional(),
});

export const YieldRankingsResponseSchema = z.object({
  rankings: z.array(YieldRankingSchema),
  riskFreeRate: z.number(),
  benchmarks: YieldBenchmarkRegistrySchema.optional(),
  scalingFactor: z.number(),
  medianApy: z.number(),
  updatedAt: z.number(),
  provenance: YieldRankingsProvenanceSchema.nullable().optional(),
  warnings: z.array(YieldResponseWarningSchema).optional(),
  publication: YieldPublicationMetadataSchema.nullable().optional(),
  methodology: MethodologyEnvelopeSchema.optional(),
});
export type YieldRankingsResponse = z.infer<typeof YieldRankingsResponseSchema>;

export const YieldHistoryResponseSchema = z.object({
  current: YieldHistoryPointSchema.nullable(),
  history: z.array(YieldHistoryPointSchema),
  warning: z.string().optional(),
  methodology: MethodologyEnvelopeSchema,
  publication: YieldPublicationMetadataSchema.nullable().optional(),
});
export type YieldHistoryResponse = z.infer<typeof YieldHistoryResponseSchema>;

export const YIELD_ADAPTER_MANIFEST_FAMILY_VALUES = [
  "onchain",
  "protocol-api",
  "defillama",
  "defillama-auto",
  "rate-derived",
  "price-derived",
  "intentional-gap",
] as const;
export type YieldAdapterManifestFamily = (typeof YIELD_ADAPTER_MANIFEST_FAMILY_VALUES)[number];

export const YieldAdapterManifestPublicEntrySchema = z.object({
  stablecoinId: z.string(),
  coinSymbol: z.string(),
  family: z.enum(YIELD_ADAPTER_MANIFEST_FAMILY_VALUES),
  sourceKey: z.string().nullable(),
  sourceKeyPattern: z.string().nullable().optional(),
  label: z.string(),
  chain: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  lifecycle: z.enum(YIELD_ADAPTER_LIFECYCLE_VALUES),
  quarantineReason: z.string().nullable().optional(),
  methodologyVersion: z.string(),
  updatedAt: z.number(),
});
export type YieldAdapterManifestPublicEntry = z.infer<typeof YieldAdapterManifestPublicEntrySchema>;

export const YieldAdapterManifestResponseSchema = z.object({
  methodologyVersion: z.string(),
  updatedAt: z.number(),
  entries: z.array(YieldAdapterManifestPublicEntrySchema),
});
export type YieldAdapterManifestResponse = z.infer<typeof YieldAdapterManifestResponseSchema>;
