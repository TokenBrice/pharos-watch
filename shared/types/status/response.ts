import { z } from "zod";
import type { DiscoveryCandidate } from "../discovery";
import { ReserveCompositionOverviewSchema, type ReserveCompositionOverview } from "../live-reserves";
import type { PriceSourceHealth } from "../pricing-source-health";
import type {
  CacheStatus,
  DataQuality,
  DatasetFreshness,
  StatusCause,
  StatusDiscrepancy,
  StatusHealthValue,
  StatusProbeSummary,
  StatusStaleness,
  StatusStateInfo,
  StatusTransition,
} from "./core";
import {
  STATUS_DISCREPANCY_REASON_VALUES,
  STATUS_PROBE_COMPARISON_REASON_VALUES,
  StatusHealthValueSchema,
} from "./core";
import type { BudgetOnlySurfaceStatus, CronStatus } from "./cron";
import type {
  CanaryStatus,
  D1UsageSummary,
  DependencyHealth,
  ProviderCircuitHealth,
  PublicationHealth,
} from "./operational";
import { CacheStatusSchema, StatusHealthOrUnknownSchema } from "./schema-primitives";
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
  | "discoveryCandidates"
  | "jobAttempts"
  | "scheduledSlots"
  | "mintBurnReconciliation"
  | "reserveDrift"
  | "classificationWarnings";

export interface StatusSectionError {
  code: string;
  message: string;
}

export type StatusSectionErrors = Partial<Record<StatusSectionKey, StatusSectionError>>;

export interface StatusResponse {
  timestamp: number;
  dbHealthy: boolean;
  availabilityStatus: StatusHealthValue;
  dataQualityStatus: StatusHealthValue;
  rawOverallStatus: StatusHealthValue;
  overallStatus: StatusHealthValue;
  confidence: number;
  causes: {
    availability: StatusCause[];
    dataQuality: StatusCause[];
    overall: StatusCause[];
  };
  state: StatusStateInfo;
  staleness: StatusStaleness;
  probe: StatusProbeSummary;
  discrepancy: StatusDiscrepancy;
  timeline: StatusTransition[];
  caches: Record<string, CacheStatus>;
  crons: Record<string, CronStatus>;
  budgetOnlySurfaces: BudgetOnlySurfaceStatus[];
  dataQuality: DataQuality;
  telegramBot: TelegramBotStats | null;
  sectionErrors: StatusSectionErrors;
  datasetFreshness: DatasetFreshness;
  summary: {
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
    activeJobAttempts?: number;
    staleJobAttempts?: number;
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
  liquidityHealth: LiquidityHealth | null;
  yieldHealth: YieldHealthSummary | null;
  publicationHealth?: PublicationHealth | null;
  dependencyHealth?: DependencyHealth | null;
  providerCircuitHealth?: ProviderCircuitHealth | null;
  canaries?: CanaryStatus | null;
  priceSourceHealth: PriceSourceHealth | null;
  /**
   * Most recent per-provider attempt diagnostics (Binance, Jupiter, …) as persisted
   * to `cron_runs.metadata.providerDiagnostics` by the sync-stablecoins cron. Kept
   * permissively typed because origin shape evolves with the pricing pipeline.
   */
  priceProviderDiagnostics: Array<Record<string, unknown>> | null;
  /**
   * Most recent GeckoTerminal probe run stats as persisted to `cron_runs.metadata.gtProbe`.
   * Kept permissively typed for the same reason as `priceProviderDiagnostics`.
   */
  gtProbe: Record<string, unknown> | null;
  coingeckoPriceDiff: CoinGeckoPriceDiff | null;
  d1Usage: D1UsageSummary | null;
  discoveryCandidates: DiscoveryCandidate[] | null;
  mintBurnReconciliation: MintBurnReconciliationSummary | null;
  reserveComposition: StatusReserveComposition;
  cacheBlobSizes?: Record<string, number>;
  reserveDrift?: ReserveDriftEntry[];
  classificationWarnings?: ClassificationWarning[];
}

export type StatusReserveComposition = ReserveCompositionOverview & {
  status: StatusHealthValue;
  freshCoverageRatio: number;
  authoritativeFreshCoverageRatio: number;
};

export interface StatusHistoryResponse {
  timestamp: number;
  state: StatusStateInfo | null;
  staleness: StatusStaleness | null;
  probe: StatusProbeSummary;
  discrepancy: StatusDiscrepancy;
  transitions: StatusTransition[];
  reserveComposition: StatusResponse["reserveComposition"] | null;
}

const StatusJsonObjectSchema = z.object({}).passthrough();

function statusObjectSchema<T>(): z.ZodType<T> {
  return z.custom<T>((value) => value != null && typeof value === "object" && !Array.isArray(value));
}

function statusRecordSchema<T>(): z.ZodType<Record<string, T>> {
  return z.record(z.string(), statusObjectSchema<T>());
}

const StatusCauseSchema = z.object({
  code: z.string(),
  layer: z.enum(["availability", "data-quality", "system"]),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  metric: z.string().optional(),
  value: z.number().optional(),
  threshold: z.number().optional(),
  runbookUrl: z.string().optional(),
});

const StatusStateInfoSchema = z.object({
  scope: z.literal("global"),
  currentStatus: StatusHealthValueSchema,
  rawStatus: StatusHealthValueSchema,
  lastEvaluatedAt: z.number(),
  lastChangedAt: z.number(),
  minDwellSec: z.number(),
  staleMinDwellSec: z.number(),
  consecutiveRaw: z.object({
    healthy: z.number(),
    degraded: z.number(),
    stale: z.number(),
  }),
  thresholds: z.object({
    escalateToDegraded: z.number(),
    escalateToStale: z.number(),
    recoverToDegraded: z.number(),
    recoverToHealthy: z.number(),
  }),
});

const StatusStalenessSchema = z.object({
  ageSeconds: z.number(),
  maxAgeSec: z.number(),
  isStale: z.boolean(),
});

const StatusProbePlaneSummarySchema = z.object({
  status: StatusHealthOrUnknownSchema,
  sampleCount: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  p95LatencyMs: z.number().nullable(),
  origins: z.array(z.string()),
});

const StatusProbeSummarySchema = z.object({
  timestamp: z.number().nullable(),
  status: StatusHealthOrUnknownSchema,
  sampleCount: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  bootstrapMissCount: z.number().optional(),
  p95LatencyMs: z.number().nullable(),
  internal: StatusProbePlaneSummarySchema.nullable().optional(),
  external: StatusProbePlaneSummarySchema.nullable().optional(),
  internalExternalDiscrepancy: z
    .object({
      hasDivergence: z.boolean(),
      severityDelta: z.number(),
      internalStatus: StatusHealthOrUnknownSchema,
      externalStatus: StatusHealthOrUnknownSchema,
      reason: z.enum(STATUS_PROBE_COMPARISON_REASON_VALUES),
      details: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

const StatusDiscrepancySchema = z.object({
  hasDivergence: z.boolean(),
  severityDelta: z.number(),
  statusSeverity: z.number(),
  probeSeverity: z.number(),
  details: z.string().nullable(),
  probeAgeSeconds: z.number().nullable(),
  consecutiveDivergent: z.number(),
  discrepancyReason: z.enum(STATUS_DISCREPANCY_REASON_VALUES),
});

const StatusTransitionSchema = z.object({
  id: z.number(),
  scope: z.literal("global"),
  from: StatusHealthValueSchema.nullable(),
  to: StatusHealthValueSchema,
  rawStatus: StatusHealthValueSchema,
  transitionType: z.enum(["degrade", "recover", "init"]),
  reason: z.string(),
  confidence: z.number(),
  causes: z.array(StatusCauseSchema),
  at: z.number(),
});

const StatusReserveCompositionSchema = ReserveCompositionOverviewSchema.extend({
  status: StatusHealthValueSchema,
  freshCoverageRatio: z.number(),
  authoritativeFreshCoverageRatio: z.number(),
}) satisfies z.ZodType<StatusReserveComposition>;

export const StatusResponseSchema: z.ZodType<StatusResponse> = z
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
    sectionErrors: z.record(z.string(), z.object({ code: z.string(), message: z.string() })),
    datasetFreshness: statusObjectSchema<DatasetFreshness>(),
    summary: statusObjectSchema<StatusResponse["summary"]>(),
    liquidityHealth: statusObjectSchema<LiquidityHealth>().nullable(),
    yieldHealth: statusObjectSchema<YieldHealthSummary>().nullable(),
    publicationHealth: statusObjectSchema<PublicationHealth>().nullable().optional(),
    dependencyHealth: statusObjectSchema<DependencyHealth>().nullable().optional(),
    providerCircuitHealth: statusObjectSchema<ProviderCircuitHealth>().nullable().optional(),
    canaries: statusObjectSchema<CanaryStatus>().nullable().optional(),
    priceSourceHealth: statusObjectSchema<PriceSourceHealth>().nullable(),
    priceProviderDiagnostics: z.array(z.record(z.string(), z.unknown())).nullable(),
    gtProbe: StatusJsonObjectSchema.nullable(),
    coingeckoPriceDiff: statusObjectSchema<CoinGeckoPriceDiff>().nullable(),
    d1Usage: statusObjectSchema<D1UsageSummary>().nullable(),
    discoveryCandidates: z.array(statusObjectSchema<DiscoveryCandidate>()).nullable(),
    mintBurnReconciliation: statusObjectSchema<MintBurnReconciliationSummary>().nullable(),
    reserveComposition: StatusReserveCompositionSchema,
    cacheBlobSizes: z.record(z.string(), z.number()).optional(),
    reserveDrift: z.array(statusObjectSchema<ReserveDriftEntry>()).optional(),
    classificationWarnings: z.array(statusObjectSchema<ClassificationWarning>()).optional(),
  })
  .passthrough()
  .transform((value): StatusResponse => ({
    ...value,
    publicationHealth: value.publicationHealth ?? null,
    dependencyHealth: value.dependencyHealth ?? null,
    providerCircuitHealth: value.providerCircuitHealth ?? null,
    canaries: value.canaries ?? null,
  }));

export const StatusHistoryResponseSchema: z.ZodType<StatusHistoryResponse> = z.object({
  timestamp: z.number(),
  state: StatusStateInfoSchema.nullable(),
  staleness: StatusStalenessSchema.nullable(),
  probe: StatusProbeSummarySchema,
  discrepancy: StatusDiscrepancySchema,
  transitions: z.array(StatusTransitionSchema),
  reserveComposition: StatusReserveCompositionSchema.nullable(),
});
