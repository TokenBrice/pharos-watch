import { z } from "zod";
import { MethodologyEnvelopeSchema, YieldTypeSchema } from "./core";
import type { MethodologyEnvelope, YieldType } from "./core";
import { ReportCardGradeSchema } from "./report-cards";
import type { ReportCardGrade } from "./report-cards";

export type YieldBenchmarkKey = "USD" | "EUR" | "CHF";
export type YieldBenchmarkSelectionMode = "native" | "fallback-usd" | "manual-override";
export type YieldSafetyProvenance = "live-report-card" | "cached-publish" | "default-safety";
export type YieldPublicationStatus = "staged" | "published" | "failed";
export type YieldVenueRiskTier = "low" | "medium" | "high" | "unknown";
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
export type YieldRankChangeDriver =
  (typeof YIELD_RANK_CHANGE_DRIVER_VALUES)[number];

export interface YieldResponseWarning {
  code: string;
  message: string;
  reasons?: string[];
}

export interface AltYieldSource {
  sourceKey: string;
  yieldSource: string;
  yieldSourceUrl?: string | null;
  yieldType: YieldType;
  currentApy: number;
  apy30d: number;
  sourceTvlUsd: number | null;
  dataSource: string;
  sourceRisk?: YieldSourceRisk | null;
}

export interface YieldPublicationMetadata {
  generationId?: string | null;
  updatedAt?: number | null;
  cutoffAt?: number | null;
  schemaVersion?: number | null;
  status?: YieldPublicationStatus | null;
}

export interface YieldSourceRisk {
  sourceRiskPenalty?: number | null;
  sourceDepthRatio?: number | null;
  rewardShare?: number | null;
  sourceAgeSeconds?: number | null;
  deploymentPlace?: string | null;
  venueProtocol?: string | null;
  venueChain?: string | null;
  venueRiskTier?: YieldVenueRiskTier | null;
  investabilityFlags?: string[];
}

export interface YieldRankChangeAttribution {
  previousRank?: number | null;
  rankDelta?: number | null;
  previousPys?: number | null;
  pysDelta?: number | null;
  primaryDriver?: YieldRankChangeDriver | null;
  driverContributions?: {
    apy?: number | null;
    benchmark?: number | null;
    stablecoinSafety?: number | null;
    sourceRisk?: number | null;
    freshness?: number | null;
    volatility?: number | null;
    tvlDepth?: number | null;
  } | null;
}

export interface YieldBenchmarkMeta {
  key?: YieldBenchmarkKey;
  label?: string;
  currency?: string;
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  ageSeconds: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
  isProxy?: boolean;
}

export interface YieldBenchmarkRegistry {
  USD: YieldBenchmarkMeta;
  EUR?: YieldBenchmarkMeta | null;
  CHF?: YieldBenchmarkMeta | null;
}

export interface YieldSourceInputMeta {
  mode: "dex-cache" | "direct-fetch" | "unavailable";
  updatedAt: number | null;
  ageSeconds: number | null;
  poolCount: number;
  fallbackMode: string | null;
}

export interface YieldSafetySnapshotMeta {
  kind: "ok" | "degraded";
  coverageRatio: number;
  coveredCount: number;
  trackedCount: number;
  reason: string | null;
}

export interface YieldRankingProvenance {
  sourceKey: string;
  sourceObservedAt: number;
  sourceAgeSeconds: number;
  comparisonAnchorObservedAt?: number | null;
  comparisonAnchorAgeSeconds?: number | null;
  confidenceTier: "deterministic" | "curated" | "discovered" | "fallback";
  selectionMethod: "confidence-weighted";
  selectionReason: string;
  sourceSwitch: boolean;
  previousBestSourceKey: string | null;
  usedLegacyHistory: boolean;
  usedDefaultSafety: boolean;
  safetyProvenance?: YieldSafetyProvenance;
  benchmarkKey?: YieldBenchmarkKey;
  benchmarkLabel?: string;
  benchmarkCurrency?: string;
  benchmarkRate?: number;
  benchmarkRecordDate: string | null;
  benchmarkIsFallback: boolean;
  benchmarkFallbackMode: string | null;
  benchmarkSelectionMode?: YieldBenchmarkSelectionMode;
  benchmarkIsProxy?: boolean;
  anomalies: string[];
}

export interface YieldRankingsProvenance {
  selectionMethod: "confidence-weighted";
  benchmark: YieldBenchmarkMeta;
  benchmarks?: YieldBenchmarkRegistry;
  dlPools: YieldSourceInputMeta;
  safetySnapshot: YieldSafetySnapshotMeta;
}

export interface YieldHistoryPoint {
  date: number | string;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  exchangeRate: number | null;
  sourceTvlUsd: number | null;
  warningSignals: string[];
  sourceKey?: string | null;
  yieldSource?: string | null;
  yieldSourceUrl?: string | null;
  yieldType?: YieldType | null;
  dataSource?: string | null;
  isBest?: boolean;
  sourceSwitch?: boolean;
  publicationGenerationId?: string | null;
  sourceRisk?: YieldSourceRisk | null;
}

const YieldHistoryPointSchema: z.ZodType<YieldHistoryPoint> = z.object({
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
  sourceRisk: z.lazy(() => YieldSourceRiskSchema).nullable().optional(),
});

const YieldPublicationMetadataSchema: z.ZodType<YieldPublicationMetadata> = z.object({
  generationId: z.string().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
  cutoffAt: z.number().nullable().optional(),
  schemaVersion: z.number().int().positive().nullable().optional(),
  status: z.enum(["staged", "published", "failed"]).nullable().optional(),
});

const YieldSourceRiskSchema: z.ZodType<YieldSourceRisk> = z.object({
  sourceRiskPenalty: z.number().min(1).nullable().optional(),
  sourceDepthRatio: z.number().min(0).nullable().optional(),
  rewardShare: z.number().min(0).max(1).nullable().optional(),
  sourceAgeSeconds: z.number().int().min(0).nullable().optional(),
  deploymentPlace: z.string().nullable().optional(),
  venueProtocol: z.string().nullable().optional(),
  venueChain: z.string().nullable().optional(),
  venueRiskTier: z.enum(["low", "medium", "high", "unknown"]).nullable().optional(),
  investabilityFlags: z.array(z.string()).optional(),
});

const YieldRankChangeAttributionSchema: z.ZodType<YieldRankChangeAttribution> = z.object({
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
});

const YieldBenchmarkMetaSchema = z.object({
  key: z.enum(["USD", "EUR", "CHF"]).optional(),
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
  EUR: YieldBenchmarkMetaSchema.nullable().optional(),
  CHF: YieldBenchmarkMetaSchema.nullable().optional(),
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
});

const YieldRankingProvenanceSchema = z.object({
  sourceKey: z.string(),
  sourceObservedAt: z.number(),
  sourceAgeSeconds: z.number(),
  comparisonAnchorObservedAt: z.number().nullable().optional(),
  comparisonAnchorAgeSeconds: z.number().nullable().optional(),
  confidenceTier: z.enum(["deterministic", "curated", "discovered", "fallback"]),
  selectionMethod: z.literal("confidence-weighted"),
  selectionReason: z.string(),
  sourceSwitch: z.boolean(),
  previousBestSourceKey: z.string().nullable(),
  usedLegacyHistory: z.boolean(),
  usedDefaultSafety: z.boolean(),
  safetyProvenance: z.enum(["live-report-card", "cached-publish", "default-safety"]).optional(),
  benchmarkKey: z.enum(["USD", "EUR", "CHF"]).optional(),
  benchmarkLabel: z.string().optional(),
  benchmarkCurrency: z.string().optional(),
  benchmarkRate: z.number().optional(),
  benchmarkRecordDate: z.string().nullable(),
  benchmarkIsFallback: z.boolean(),
  benchmarkFallbackMode: z.string().nullable(),
  benchmarkSelectionMode: z.enum(["native", "fallback-usd", "manual-override"]).optional(),
  benchmarkIsProxy: z.boolean().optional(),
  anomalies: z.array(z.string()),
});

const YieldRankingsProvenanceSchema = z.object({
  selectionMethod: z.literal("confidence-weighted"),
  benchmark: YieldBenchmarkMetaSchema,
  benchmarks: YieldBenchmarkRegistrySchema.optional(),
  dlPools: YieldSourceInputMetaSchema,
  safetySnapshot: YieldSafetySnapshotMetaSchema,
});

export interface YieldRanking {
  id: string;
  symbol: string;
  name: string;
  currentApy: number;
  apy7d: number;
  apy30d: number;
  apyBase: number | null;
  apyReward: number | null;
  yieldSource: string;
  yieldSourceUrl?: string | null;
  yieldType: YieldType;
  dataSource: string;
  sourceTvlUsd: number | null;
  pharosYieldScore: number | null;
  safetyScore: number | null;
  safetyGrade: ReportCardGrade | null;
  yieldToRisk: number | null;
  excessYield: number | null;
  benchmarkKey?: YieldBenchmarkKey;
  benchmarkLabel?: string;
  benchmarkCurrency?: string;
  benchmarkRate?: number;
  benchmarkRecordDate?: string | null;
  benchmarkIsFallback?: boolean;
  benchmarkFallbackMode?: string | null;
  benchmarkSelectionMode?: YieldBenchmarkSelectionMode;
  benchmarkIsProxy?: boolean;
  yieldStability: number | null;
  apyVariance30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
  warningSignals: string[];
  altSources: AltYieldSource[];
  provenance?: YieldRankingProvenance | null;
  publicationGenerationId?: string | null;
  publishedRank?: number | null;
  liveRank?: number | null;
  sourceRisk?: YieldSourceRisk | null;
  rankChangeAttribution?: YieldRankChangeAttribution | null;
}

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
  safetyScore: z.number().nullable(),
  safetyGrade: ReportCardGradeSchema.nullable(),
  yieldToRisk: z.number().nullable(),
  excessYield: z.number().nullable(),
  benchmarkKey: z.enum(["USD", "EUR", "CHF"]).optional(),
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
  provenance: YieldRankingProvenanceSchema.nullable().optional(),
  publicationGenerationId: z.string().nullable().optional(),
  publishedRank: z.number().int().positive().nullable().optional(),
  liveRank: z.number().int().positive().nullable().optional(),
  sourceRisk: YieldSourceRiskSchema.nullable().optional(),
  rankChangeAttribution: YieldRankChangeAttributionSchema.nullable().optional(),
});

export interface YieldRankingsResponse {
  rankings: YieldRanking[];
  riskFreeRate: number;
  benchmarks?: YieldBenchmarkRegistry;
  scalingFactor: number;
  medianApy: number;
  updatedAt: number;
  provenance?: YieldRankingsProvenance | null;
  warnings?: YieldResponseWarning[];
  publication?: YieldPublicationMetadata | null;
}

export const YieldRankingsResponseSchema: z.ZodType<YieldRankingsResponse> = z.object({
  rankings: z.array(YieldRankingSchema),
  riskFreeRate: z.number(),
  benchmarks: YieldBenchmarkRegistrySchema.optional(),
  scalingFactor: z.number(),
  medianApy: z.number(),
  updatedAt: z.number(),
  provenance: YieldRankingsProvenanceSchema.nullable().optional(),
  warnings: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        reasons: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  publication: YieldPublicationMetadataSchema.nullable().optional(),
});

export interface YieldHistoryResponse {
  current: YieldHistoryPoint | null;
  history: YieldHistoryPoint[];
  warning?: string;
  methodology: MethodologyEnvelope;
  publication?: YieldPublicationMetadata | null;
}

export const YieldHistoryResponseSchema: z.ZodType<YieldHistoryResponse> = z.object({
  current: YieldHistoryPointSchema.nullable(),
  history: z.array(YieldHistoryPointSchema),
  warning: z.string().optional(),
  methodology: MethodologyEnvelopeSchema,
  publication: YieldPublicationMetadataSchema.nullable().optional(),
});
