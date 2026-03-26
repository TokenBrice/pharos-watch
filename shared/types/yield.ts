import { z } from "zod";
import { MethodologyEnvelope, MethodologyEnvelopeSchema, YieldType, YieldTypeSchema } from "./core";
import { ReportCardGrade, ReportCardGradeSchema } from "./report-cards";

export type YieldBenchmarkKey = "USD" | "EUR" | "CHF";
export type YieldBenchmarkSelectionMode = "native" | "fallback-usd" | "manual-override";

export interface AltYieldSource {
  sourceKey: string;
  yieldSource: string;
  yieldSourceUrl?: string | null;
  yieldType: YieldType;
  currentApy: number;
  apy30d: number;
  sourceTvlUsd: number | null;
  dataSource: string;
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
});

export interface YieldRankingsResponse {
  rankings: YieldRanking[];
  riskFreeRate: number;
  benchmarks?: YieldBenchmarkRegistry;
  scalingFactor: number;
  medianApy: number;
  updatedAt: number;
  provenance?: YieldRankingsProvenance | null;
}

export const YieldRankingsResponseSchema: z.ZodType<YieldRankingsResponse> = z.object({
  rankings: z.array(YieldRankingSchema),
  riskFreeRate: z.number(),
  benchmarks: YieldBenchmarkRegistrySchema.optional(),
  scalingFactor: z.number(),
  medianApy: z.number(),
  updatedAt: z.number(),
  provenance: YieldRankingsProvenanceSchema.nullable().optional(),
});

export interface YieldHistoryResponse {
  current: YieldHistoryPoint | null;
  history: YieldHistoryPoint[];
  methodology: MethodologyEnvelope;
}

export const YieldHistoryResponseSchema: z.ZodType<YieldHistoryResponse> = z.object({
  current: YieldHistoryPointSchema.nullable(),
  history: z.array(YieldHistoryPointSchema),
  methodology: MethodologyEnvelopeSchema,
});
