import { z } from "zod";
import { ReserveCompositionOverviewSchema } from "../live-reserves";
import { PriceSourceHealthSchema } from "../pricing-source-health";
import {
  DataQualitySchema,
  DatasetFreshnessSchema,
  StatusCauseSchema,
  StatusDiscrepancySchema,
  StatusHealthValueSchema,
  StatusProbeSummarySchema,
  StatusStateInfoSchema,
  StatusStalenessSchema,
  StatusTransitionSchema,
} from "./core";
import { BudgetOnlySurfaceStatusSchema, CronStatusSchema } from "./cron";
import {
  CanaryStatusSchema,
  D1UsageSummarySchema,
  DependencyHealthSchema,
  ProducerHeadStatusSchema,
  ProviderCircuitHealthSchema,
  PublicationHealthSchema,
} from "./operational";
import { TelegramBotStatsSchema } from "./telegram";
import { HealthResponseSchema } from "./public-health";
import { CacheStatusSchema } from "./schema-primitives";
import {
  ClassificationWarningSchema,
  CoinGeckoPriceDiffSchema,
  LiquidityHealthSchema,
  MintBurnReconciliationSummarySchema,
  ReserveDriftEntrySchema,
  YieldHealthSummarySchema,
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

export const StatusSummarySchema = z.object({
  unhealthyCrons: z.number(),
  availabilityImpactingUnhealthyCrons: z.number(),
  watchUnhealthyCrons: z.number(),
  degradedCrons: z.number(),
  cronErrors: z.number(),
  availabilityImpactingCronErrors: z.number(),
  /** Count of availability-critical crons with 2+ consecutive failed runs (sustained outage). */
  availabilityImpactingConsecutiveCronErrors: z.number(),
  staleCronArtifacts: z.number().optional(),
  expiredCronLeases: z.number().optional(),
  orphanedCronProgressRows: z.number().optional(),
  scheduledSlotRunning: z.number().optional(),
  scheduledSlotStaleCandidates: z.number().optional(),
  scheduledSlotOldestRunningAgeSec: z.number().nullable().optional(),
  scheduledSlotRunningQueryFailed: z.boolean().optional(),
  scheduledSlotEventMarkerQueryFailed: z.boolean().optional(),
  budgetOnlySurfaceCount: z.number().optional(),
  budgetOnlySurfaceMissingTelemetry: z.number().optional(),
  budgetOnlySurfaceStaleTelemetry: z.number().optional(),
  budgetOnlySurfaceErrors: z.number().optional(),
  canaryTotalChecks: z.number().optional(),
  canaryErrorCount: z.number().optional(),
  canaryDegradedCount: z.number().optional(),
  canarySkippedCount: z.number().optional(),
  canaryStaleCount: z.number().optional(),
  diagnosticIssueCount: z.number(),
  worstCacheRatio: z.number(),
  /**
   * Count of rows inserted into `status_transitions` in the last 24 hours.
   * A defensive observability signal added in Workstream 5 of
   * 2026-04-13 status-stability hardening so operators
   * can spot new flapping lanes as thresholds drift without spelunking
   * the transitions table. Under normal operation this should be ≤ 2.
   */
  transitionsLast24h: z.number(),
});
type StatusSummary = z.output<typeof StatusSummarySchema>;

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
    crons: z.record(z.string(), CronStatusSchema),
    budgetOnlySurfaces: z.array(BudgetOnlySurfaceStatusSchema),
    dataQuality: DataQualitySchema,
    telegramBot: TelegramBotStatsSchema.nullable(),
    sectionErrors: z.record(z.string(), StatusSectionErrorSchema),
    datasetFreshness: DatasetFreshnessSchema,
    summary: StatusSummarySchema,
    liquidityHealth: LiquidityHealthSchema.nullable(),
    yieldHealth: YieldHealthSummarySchema.nullable(),
    publicationHealth: PublicationHealthSchema.nullable().optional(),
    dependencyHealth: DependencyHealthSchema.nullable().optional(),
    providerCircuitHealth: ProviderCircuitHealthSchema.nullable().optional(),
    canaries: CanaryStatusSchema.nullable().optional(),
    telegramSummary: HealthResponseSchema.shape.telegramSummary,
    producerHeads: z.array(ProducerHeadStatusSchema).optional(),
    priceSourceHealth: PriceSourceHealthSchema.nullable(),
    coingeckoPriceDiff: CoinGeckoPriceDiffSchema.nullable(),
    d1Usage: D1UsageSummarySchema.nullable(),
    mintBurnReconciliation: MintBurnReconciliationSummarySchema.nullable(),
    reserveComposition: StatusReserveCompositionSchema,
    reserveDrift: z.array(ReserveDriftEntrySchema).optional(),
    classificationWarnings: z.array(ClassificationWarningSchema).optional(),
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
