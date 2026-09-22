import { z } from "zod";
import { MethodologyEnvelopeSchema, YieldTypeSchema } from "./core";
import { ReportCardGradeSchema } from "./report-card-grade";
import { SafetyScorePublicationIdentitySchema } from "./safety-score-publication";
import {
  YIELD_ADAPTER_LIFECYCLE_VALUES,
  YIELD_BENCHMARK_KEY_VALUES,
  YIELD_CALCULATION_MODE_VALUES,
  YIELD_DECISION_REJECTION_REASON_CODES,
  YIELD_EVIDENCE_CLASS_VALUES,
  YIELD_PYS_NULL_REASONS,
  YIELD_SAFETY_REASON_VALUES,
  YIELD_SCORE_QUALIFICATION_VALUES,
  YIELD_SOURCE_CONFIDENCE_TIER_VALUES,
  YIELD_SOURCE_ROLE_VALUES,
} from "./yield-vocabulary";
import {
  YieldHistoryPointSchema,
  YieldPublicDecisionLedgerSchema,
  YieldPublicationMetadataSchema,
  YieldRankChangeAttributionSchema,
  YieldSourceRiskSchema,
} from "./yield-evidence-schemas";

export * from "./yield-vocabulary";
export * from "./yield-evidence-schemas";

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
  evidenceCompleteness: z.number().min(0).max(1).nullable().optional(),
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
  /**
   * Per-key bound on the age of this entry's own observation (`recordDate`).
   * Published so consumers judge a monthly series (CAD, 45d) and a daily one
   * (USD, 5d) against their real cadence instead of a single fallback bound.
   */
  maxRecordAgeSec: z.number().optional(),
  /** Observation age at publication time; `null` when `recordDate` is absent or unparseable. */
  recordAgeSec: z.number().nullable().optional(),
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
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema.nullable().optional(),
  publicationGenerationId: z.string().nullable().optional(),
  methodologyVersion: z.string().nullable().optional(),
  publishedAt: z.number().nullable().optional(),
});

const YieldLiveSafetyHydrationMetaSchema = z.object({
  kind: z.enum(["ok", "degraded"]),
  // Present when live hydration is unusable but the response still carries the
  // cached payload's own coherent publish-time safety values instead of NR.
  fallback: z.enum(["publish-time-snapshot"]).optional(),
  coverageRatio: z.number(),
  coveredCount: z.number(),
  trackedCount: z.number(),
  reason: z.string().nullable(),
  // Non-V9 labels are historical readers, not live source choices.
  source: z.enum(["safety-score-v9-publication", "report-card-cache", "report-cards:snapshot", "computed-report-cards"]),
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
  evidenceCompleteness: z.number().min(0).max(1).nullable().optional(),
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

/**
 * Freshness envelope every cached yield response carries (`_meta`), mirroring
 * `YieldSummaryFreshnessMetaSchema` in `yield-summary.ts`.
 */
const YieldResponseFreshnessMetaSchema = z
  .object({
    updatedAt: z.number(),
    ageSeconds: z.number(),
    status: z.enum(["fresh", "degraded", "stale"]),
  })
  .strict();

export const YieldRankingsResponseSchema = z.object({
  rankings: z.array(YieldRankingSchema),
  riskFreeRate: z.number(),
  benchmarks: YieldBenchmarkRegistrySchema.optional(),
  scalingFactor: z.number(),
  medianApy: z.number(),
  updatedAt: z.number(),
  _meta: YieldResponseFreshnessMetaSchema.optional(),
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
