import { z } from "zod";
import type { StatusHealthValue } from "./core";
import { ActivePriceCoverageHealthSchema, StablecoinPublicationHealthSchema, StatusHealthValueSchema } from "./core";
import { AlertBrokerHealthSummarySchema } from "./operational";
import { CacheStatusSchema } from "./schema-primitives";
import { FreshnessStatusSchema } from "../api-meta";
import {
  RESERVE_ALERT_SOURCE_STATE_VALUES,
  SAFETY_ALERT_SOURCE_STATE_VALUES,
  TelegramPendingDeliveryBacklogSchema,
} from "./telegram";

const SafetyAlertFieldsNullableSchemaShape = {
  safetyAlertSourceState: z.enum(SAFETY_ALERT_SOURCE_STATE_VALUES).nullable(),
  safetyAlertSourceAgeSeconds: z.number().nullable(),
  safetyAlertsSuppressed: z.boolean().nullable(),
  safetyAlertSourceGeneration: z.string().nullable(),
} as const;

const ReserveAlertFieldsNullableSchemaShape = {
  reserveAlertSourceState: z.enum(RESERVE_ALERT_SOURCE_STATE_VALUES).nullable().optional(),
  reserveAlertSourceAgeSeconds: z.number().nullable().optional(),
  reserveAlertsSuppressed: z.boolean().nullable().optional(),
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
  pendingDeliveryBacklog: TelegramPendingDeliveryBacklogSchema.required({ claimable: true }).optional(),
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

export const SchedulerLivenessSchema = z.object({
  status: z.enum(["healthy", "degraded", "stale", "unavailable"]),
  observedAt: z.number().finite(),
  /** Permanent context subject to clock validity; never renews either role's freshness. */
  lastAnyStartedAt: z.number().finite().nullable(),
  lastFiveMinuteStartedAt: z.number().finite().nullable(),
  ageSeconds: z.number().finite().nonnegative().nullable(),
  warningAfterSec: z.number().positive(),
  staleAfterSec: z.number().positive(),
  lanes: z.array(z.object({
    scheduleKey: z.string(),
    lastStartedAt: z.number().finite().nullable(),
  })),
  unavailableReason: z.string().nullable(),
  heavy: z.object({
    scheduleKey: z.string().nullable(),
    lastStartedAt: z.number().finite().nullable(),
    ageSeconds: z.number().finite().nonnegative().nullable(),
    warningAfterSec: z.number().positive(),
    staleAfterSec: z.number().positive(),
    status: z.enum(["healthy", "degraded", "stale", "unavailable"]),
    unavailableReason: z.string().nullable(),
  }),
});
export type SchedulerLiveness = z.output<typeof SchedulerLivenessSchema>;

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
      freshnessStatus: FreshnessStatusSchema,
      warning: z.string().nullable(),
      criticalLaneHealthy: z.boolean(),
    }),
  }),
  circuits: z.record(z.string(), CircuitRecordSchema),
  stablecoinPublication: StablecoinPublicationHealthSchema.optional(),
  activePriceCoverage: ActivePriceCoverageHealthSchema.optional(),
  alertBroker: AlertBrokerHealthSummarySchema.optional(),
  schedulerLiveness: SchedulerLivenessSchema.optional(),
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
