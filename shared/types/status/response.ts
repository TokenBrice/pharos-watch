import { z } from "zod";
import { ReserveCompositionOverviewSchema } from "../live-reserves";
import type { PriceSourceHealth } from "../pricing-source-health";
import type {
  DataQuality,
  DatasetFreshness,
} from "./core";
import {
  StatusCauseSchema,
  StatusDiscrepancySchema,
  StatusHealthValueSchema,
  StatusProbeSummarySchema,
  StatusStateInfoSchema,
  StatusStalenessSchema,
  StatusTransitionSchema,
} from "./core";
import type { BudgetOnlySurfaceStatus, CronStatus } from "./cron";
import type {
  CanaryStatus,
  AlertBrokerHealthSummary,
  D1UsageSummary,
  DependencyHealth,
  ProviderCircuitHealth,
  PublicationHealth,
  ProducerHeadStatus,
} from "./operational";
import { CacheStatusSchema } from "./schema-primitives";
import type { TelegramBotStats } from "./telegram";
import type {
  ClassificationWarning,
  CoinGeckoPriceDiff,
  LiquidityHealth,
  MintBurnReconciliationSummary,
  ReserveDriftEntry,
  YieldHealthSummary,
} from "./yield-liquidity";

export type StatusSectionKey =
  | "statusState"
  | "statusSnapshot"
  | "telegramBot"
  | "reserveComposition"
  | "d1Usage"
  | "liquidityHealth"
  | "yieldHealth"
  | "publicationHealth"
  | "dependencyHealth"
  | "providerCircuitHealth"
  | "canaries"
  | "priceSourceHealth"
  | "coingeckoPriceDiff"
  | "scheduledSlots"
  | "mintBurnReconciliation"
  | "reserveDrift"
  | "classificationWarnings"
  | "producerHistory";

const StatusSectionErrorSchema = z.object({ code: z.string(), message: z.string() });
export type StatusSectionError = z.output<typeof StatusSectionErrorSchema>;

export type StatusSectionErrors = Partial<Record<StatusSectionKey, StatusSectionError>>;

type StatusSummary = {
    unhealthyCrons: number;
    availabilityImpactingUnhealthyCrons: number;
    watchUnhealthyCrons: number;
    degradedCrons: number;
    cronErrors: number;
    availabilityImpactingCronErrors: number;
    /** Count of availability-critical crons with 2+ consecutive failed runs (sustained outage). */
    availabilityImpactingConsecutiveCronErrors: number;
    staleCronArtifacts?: number;
    expiredCronLeases?: number;
    orphanedCronProgressRows?: number;
    scheduledSlotRunning?: number;
    scheduledSlotStaleCandidates?: number;
    scheduledSlotOldestRunningAgeSec?: number | null;
    scheduledSlotRunningQueryFailed?: boolean;
    scheduledSlotEventMarkerQueryFailed?: boolean;
    budgetOnlySurfaceCount?: number;
    budgetOnlySurfaceMissingTelemetry?: number;
    budgetOnlySurfaceStaleTelemetry?: number;
    budgetOnlySurfaceErrors?: number;
    canaryTotalChecks?: number;
    canaryErrorCount?: number;
    canaryDegradedCount?: number;
    canarySkippedCount?: number;
    canaryStaleCount?: number;
    diagnosticIssueCount: number;
    worstCacheRatio: number;
    /**
     * Count of rows inserted into `status_transitions` in the last 24 hours.
     * A defensive observability signal added in Workstream 5 of
     * 2026-04-13 status-stability hardening so operators
     * can spot new flapping lanes as thresholds drift without spelunking
     * the transitions table. Under normal operation this should be ≤ 2.
     */
    transitionsLast24h: number;
};

const StatusJsonObjectSchema = z.object({}).passthrough();

function statusObjectSchema<T>(): z.ZodType<T> {
  return z.custom<T>((value) => value != null && typeof value === "object" && !Array.isArray(value));
}

function statusRecordSchema<T>(): z.ZodType<Record<string, T>> {
  return z.record(z.string(), statusObjectSchema<T>());
}

const StatusReserveCompositionSchema = ReserveCompositionOverviewSchema.extend({
  status: StatusHealthValueSchema,
  freshCoverageRatio: z.number(),
  authoritativeFreshCoverageRatio: z.number(),
});

const StatusResponseObjectSchema = z
  .object({
    timestamp: z.number(),
    dbHealthy: z.boolean(),
    availabilityStatus: StatusHealthValueSchema,
    dataQualityStatus: StatusHealthValueSchema,
    rawOverallStatus: StatusHealthValueSchema,
    overallStatus: StatusHealthValueSchema,
    confidence: z.number(),
    causes: z.object({
      availability: z.array(StatusCauseSchema),
      dataQuality: z.array(StatusCauseSchema),
      overall: z.array(StatusCauseSchema),
    }),
    state: StatusStateInfoSchema,
    staleness: StatusStalenessSchema,
    probe: StatusProbeSummarySchema,
    discrepancy: StatusDiscrepancySchema,
    timeline: z.array(StatusTransitionSchema),
    caches: z.record(z.string(), CacheStatusSchema),
    crons: statusRecordSchema<CronStatus>(),
    budgetOnlySurfaces: z.array(statusObjectSchema<BudgetOnlySurfaceStatus>()),
    dataQuality: statusObjectSchema<DataQuality>(),
    telegramBot: statusObjectSchema<TelegramBotStats>().nullable(),
    sectionErrors: z.record(z.string(), StatusSectionErrorSchema),
    datasetFreshness: statusObjectSchema<DatasetFreshness>(),
    summary: statusObjectSchema<StatusSummary>(),
    liquidityHealth: statusObjectSchema<LiquidityHealth>().nullable(),
    yieldHealth: statusObjectSchema<YieldHealthSummary>().nullable(),
    publicationHealth: statusObjectSchema<PublicationHealth>().nullable().optional(),
    dependencyHealth: statusObjectSchema<DependencyHealth>().nullable().optional(),
    providerCircuitHealth: statusObjectSchema<ProviderCircuitHealth>().nullable().optional(),
    canaries: statusObjectSchema<CanaryStatus>().nullable().optional(),
    alertBroker: statusObjectSchema<AlertBrokerHealthSummary>().optional(),
    producerHeads: z.array(statusObjectSchema<ProducerHeadStatus>()).optional(),
    priceSourceHealth: statusObjectSchema<PriceSourceHealth>().nullable(),
    priceProviderDiagnostics: z.array(z.record(z.string(), z.unknown())).nullable(),
    gtProbe: StatusJsonObjectSchema.nullable(),
    coingeckoPriceDiff: statusObjectSchema<CoinGeckoPriceDiff>().nullable(),
    d1Usage: statusObjectSchema<D1UsageSummary>().nullable(),
    mintBurnReconciliation: statusObjectSchema<MintBurnReconciliationSummary>().nullable(),
    reserveComposition: StatusReserveCompositionSchema,
    cacheBlobSizes: z.record(z.string(), z.number()).optional(),
    reserveDrift: z.array(statusObjectSchema<ReserveDriftEntry>()).optional(),
    classificationWarnings: z.array(statusObjectSchema<ClassificationWarning>()).optional(),
  })
  .passthrough();

export const StatusResponseSchema = StatusResponseObjectSchema.transform((value) => ({
    ...value,
    publicationHealth: value.publicationHealth ?? null,
    dependencyHealth: value.dependencyHealth ?? null,
    providerCircuitHealth: value.providerCircuitHealth ?? null,
    canaries: value.canaries ?? null,
  }));
export type StatusResponse = z.output<typeof StatusResponseSchema>;

export const StatusHistoryResponseSchema = z.object({
  timestamp: z.number(),
  state: StatusStateInfoSchema.nullable(),
  staleness: StatusStalenessSchema.nullable(),
  probe: StatusProbeSummarySchema,
  discrepancy: StatusDiscrepancySchema,
  transitions: z.array(StatusTransitionSchema),
  hasMore: z.boolean().nullable().default(null),
  reserveComposition: StatusReserveCompositionSchema.nullable(),
});
export type StatusHistoryResponse = z.output<typeof StatusHistoryResponseSchema>;
