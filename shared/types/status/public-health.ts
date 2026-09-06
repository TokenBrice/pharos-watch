import { z } from "zod";
import type { StatusHealthValue } from "./core";
import { StatusHealthValueSchema } from "./core";
import { CacheStatusSchema } from "./schema-primitives";
import {
  RESERVE_ALERT_SOURCE_STATE_VALUES,
  SAFETY_ALERT_SOURCE_STATE_VALUES,
} from "./telegram";

const SafetyAlertFieldsNullableSchemaShape = {
  safetyAlertSourceState: z.enum(SAFETY_ALERT_SOURCE_STATE_VALUES).nullable(),
  safetyAlertSourceAgeSeconds: z.number().nullable(),
  safetyAlertsSuppressed: z.boolean(),
  safetyAlertSourceGeneration: z.string().nullable(),
} as const;

const ReserveAlertFieldsNullableSchemaShape = {
  reserveAlertSourceState: z.enum(RESERVE_ALERT_SOURCE_STATE_VALUES).nullable().optional(),
  reserveAlertSourceAgeSeconds: z.number().nullable().optional(),
  reserveAlertsSuppressed: z.boolean().optional(),
  reserveAlertSourceGeneration: z.string().nullable().optional(),
} as const;

export const PUBLIC_STATUS_HISTORY_WINDOWS = ["24h", "7d", "30d"] as const;

export type PublicStatusHistoryWindow = (typeof PUBLIC_STATUS_HISTORY_WINDOWS)[number];

export const PublicStatusTransitionSchema = z
  .object({
    id: z.number(),
    from: StatusHealthValueSchema.nullable(),
    to: StatusHealthValueSchema,
    transitionType: z.enum(["degrade", "recover", "init"]),
    reason: z.string(),
    at: z.number(),
  })
  .passthrough();
export type PublicStatusTransition = z.output<typeof PublicStatusTransitionSchema>;

export const PublicStatusHistoryResponseSchema = z
  .object({
    timestamp: z.number(),
    currentStatus: StatusHealthValueSchema,
    lastChangedAt: z.number().nullable(),
    transitions: z.array(PublicStatusTransitionSchema),
  })
  .passthrough();
export type PublicStatusHistoryResponse = z.output<typeof PublicStatusHistoryResponseSchema>;

export const CircuitRecordSchema = z.object({
  state: z.enum(["closed", "half-open", "open"]),
  consecutiveFailures: z.number(),
  lastFailureAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  openedAt: z.number().nullable(),
});
export type CircuitRecord = z.infer<typeof CircuitRecordSchema>;

const TelegramHealthSummarySchema = z.object({
  totalChats: z.number(),
  pendingDeliveries: z.number().nullable(),
  pendingDeliveryLifecycleStatus: z.enum(["available", "unknown"]).optional(),
  pendingDeliveryBacklog: z.object({
    claimable: z.number(),
    due: z.number(),
    deferred: z.number(),
    expired: z.number(),
    nearTtl: z.number().optional(),
    sending: z.number().optional(),
    pendingSending: z.number().optional(),
    freshSending: z.number().optional(),
    executionUnknown: z.number().optional(),
    pendingExecutionUnknown: z.number().optional(),
    freshExecutionUnknown: z.number().optional(),
    oldestExecutionUnknownAgeSec: z.number().nullable().optional(),
    executionUnknownSampleLimit: z.number().optional(),
    executionUnknownLowerBound: z.boolean().optional(),
    sentCleanup: z.number().optional(),
  }).optional(),
  lastDispatchAt: z.number().nullable(),
  lastDispatchStatus: z.string().nullable(),
  ...SafetyAlertFieldsNullableSchemaShape,
  ...ReserveAlertFieldsNullableSchemaShape,
});
export type TelegramHealthSummary = z.output<typeof TelegramHealthSummarySchema>;

const MintBurnHealthQueryErrorsSchema = z.object({
  latestSuccessfulSyncAt: z.string().nullable(),
  rowCount: z.string().nullable(),
});

export const HealthResponseSchema = z.object({
  status: StatusHealthValueSchema,
  timestamp: z.number(),
  warnings: z.array(z.string()),
  caches: z.record(z.string(), CacheStatusSchema),
  blacklist: z.object({
    totalEvents: z.number(),
    missingAmounts: z.number(),
    recentMissingAmounts: z.number(),
    recentWindowSec: z.number(),
    missingRatio: z.number(),
  }),
  mintBurn: z.object({
    totalEvents: z.number().nullable(),
    latestEventTs: z.number().nullable(),
    latestHourlyTs: z.number().nullable(),
    freshnessAgeSec: z.number().nullable(),
    majorStaleCount: z.number(),
    staleMajorSymbols: z.array(z.string()),
    queryErrors: MintBurnHealthQueryErrorsSchema.optional(),
    sync: z.object({
      lastSuccessfulSyncAt: z.number().nullable(),
      freshnessStatus: z.enum(["fresh", "degraded", "stale"]),
      warning: z.string().nullable(),
      criticalLaneHealthy: z.boolean(),
    }),
  }),
  circuits: z.record(z.string(), CircuitRecordSchema),
  stablecoinPublication: z.object({
    status: z.enum(["complete", "incomplete", "unknown"]),
    expectedActiveCount: z.number(),
    presentActiveCount: z.number(),
    waivedActiveCount: z.number(),
    missingActiveIds: z.array(z.string()),
    waivedActiveIds: z.array(z.string()),
    expiredWaiverIds: z.array(z.string()),
    observedAt: z.number().nullable(),
  }).optional(),
  activePriceCoverage: z.object({
    status: z.enum(["complete", "incomplete", "unknown"]),
    expectedActiveCount: z.number(),
    presentActiveCount: z.number(),
    pricedActiveCount: z.number(),
    missingPriceCount: z.number(),
    pricedActiveIds: z.array(z.string()),
    missingActiveIds: z.array(z.string()),
    affectedMarketCapUsd: z.number(),
    missingActiveAssets: z.array(z.object({
      stablecoinId: z.string(),
      symbol: z.string().default("unknown"),
      marketCapUsd: z.number().nullable(),
      currentPrice: z.number().nullable(),
      currentSource: z.string().nullable(),
      currentObservedAt: z.number().nullable(),
      currentConfidence: z.string().nullable(),
      consecutiveMissingGenerations: z.number().default(1),
      lastAcceptedPrice: z.number().nullable().default(null),
      lastAcceptedSource: z.string().nullable().default(null),
      lastAcceptedObservedAt: z.number().nullable().default(null),
      rejectionReason: z.string().default("no-accepted-price"),
      alertEligible: z.boolean().default(false),
    })),
    alertEligibleCount: z.number().default(0),
    alertEligibleIds: z.array(z.string()).default([]),
    maxConsecutiveMissingGenerations: z.number().default(0),
    observedAt: z.number().nullable(),
  }).optional(),
  alertBroker: z.object({
    activeCount: z.number(),
    pendingCount: z.number(),
    criticalActiveCount: z.number(),
    failedDeliveryCount: z.number(),
    missingTargetCount: z.number(),
    oldestActiveAt: z.number().nullable(),
    activeConditionKeys: z.array(z.string()),
    queryFailed: z.boolean(),
  }).optional(),
  telegramSummary: TelegramHealthSummarySchema.nullable().optional(),
});
export type HealthResponse = z.output<typeof HealthResponseSchema>;

export interface EndpointProbeResult {
  path: string;
  status: number | null;
  latencyMs: number;
  error?: string;
  semanticStatus?: StatusHealthValue;
  semanticDetail?: string | null;
  semanticScope?: "health" | "status" | "freshness";
}
