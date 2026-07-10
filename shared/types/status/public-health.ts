import { z } from "zod";
import type { CacheStatus, StablecoinPublicationHealth, StatusHealthValue } from "./core";
import { StatusHealthValueSchema } from "./core";
import { CacheStatusSchema } from "./schema-primitives";
import { SAFETY_ALERT_SOURCE_STATE_VALUES, type SafetyAlertFieldsNullable } from "./telegram";
import type { AlertBrokerHealthSummary } from "./operational";
import { D1CapacityAssessmentSchema, type D1CapacityAssessment } from "./d1-capacity";

const SafetyAlertFieldsNullableSchemaShape = {
  safetyAlertSourceState: z.enum(SAFETY_ALERT_SOURCE_STATE_VALUES).nullable(),
  safetyAlertSourceAgeSeconds: z.number().nullable(),
  safetyAlertsSuppressed: z.boolean(),
  safetyAlertSourceGeneration: z.string().nullable(),
} as const;

export interface PublicStatusTransition {
  id: number;
  from: StatusHealthValue | null;
  to: StatusHealthValue;
  transitionType: "degrade" | "recover" | "init";
  reason: string;
  at: number;
}

export const PUBLIC_STATUS_HISTORY_WINDOWS = ["24h", "7d", "30d"] as const;

export type PublicStatusHistoryWindow = (typeof PUBLIC_STATUS_HISTORY_WINDOWS)[number];

export interface PublicStatusHistoryResponse {
  timestamp: number;
  currentStatus: StatusHealthValue;
  lastChangedAt: number | null;
  transitions: PublicStatusTransition[];
}

export const PublicStatusTransitionSchema: z.ZodType<PublicStatusTransition> = z
  .object({
    id: z.number(),
    from: StatusHealthValueSchema.nullable(),
    to: StatusHealthValueSchema,
    transitionType: z.enum(["degrade", "recover", "init"]),
    reason: z.string(),
    at: z.number(),
  })
  .passthrough();

export const PublicStatusHistoryResponseSchema: z.ZodType<PublicStatusHistoryResponse> = z
  .object({
    timestamp: z.number(),
    currentStatus: StatusHealthValueSchema,
    lastChangedAt: z.number().nullable(),
    transitions: z.array(PublicStatusTransitionSchema),
  })
  .passthrough();

const CircuitRecordSchema = z.object({
  state: z.enum(["closed", "half-open", "open"]),
  consecutiveFailures: z.number(),
  lastFailureAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  openedAt: z.number().nullable(),
});
export type CircuitRecord = z.infer<typeof CircuitRecordSchema>;

export interface TelegramHealthSummary extends SafetyAlertFieldsNullable {
  totalChats: number;
  pendingDeliveries: number;
  lastDispatchAt: number | null;
  lastDispatchStatus: string | null;
}

export interface MintBurnHealthQueryErrors {
  latestSuccessfulSyncAt: string | null;
  rowCount: string | null;
}

export interface HealthResponse {
  status: StatusHealthValue;
  timestamp: number;
  warnings: string[];
  caches: Record<string, CacheStatus>;
  blacklist: {
    totalEvents: number;
    missingAmounts: number;
    recentMissingAmounts: number;
    recentWindowSec: number;
    missingRatio: number;
  };
  mintBurn: {
    totalEvents: number | null;
    latestEventTs: number | null;
    latestHourlyTs: number | null;
    freshnessAgeSec: number | null;
    majorStaleCount: number;
    staleMajorSymbols: string[];
    queryErrors?: MintBurnHealthQueryErrors;
    sync: {
      lastSuccessfulSyncAt: number | null;
      freshnessStatus: "fresh" | "degraded" | "stale";
      warning: string | null;
      criticalLaneHealthy: boolean;
    };
  };
  circuits: Record<string, CircuitRecord>;
  stablecoinPublication?: StablecoinPublicationHealth;
  d1Capacity?: D1CapacityAssessment | null;
  alertBroker?: AlertBrokerHealthSummary;
  telegramSummary?: TelegramHealthSummary | null;
}

const TelegramHealthSummarySchema = z.object({
  totalChats: z.number(),
  pendingDeliveries: z.number(),
  lastDispatchAt: z.number().nullable(),
  lastDispatchStatus: z.string().nullable(),
  ...SafetyAlertFieldsNullableSchemaShape,
});

const MintBurnHealthQueryErrorsSchema: z.ZodType<MintBurnHealthQueryErrors> = z.object({
  latestSuccessfulSyncAt: z.string().nullable(),
  rowCount: z.string().nullable(),
});

export const HealthResponseSchema: z.ZodType<HealthResponse> = z.object({
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
  d1Capacity: D1CapacityAssessmentSchema.nullable().optional(),
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

export interface EndpointProbeResult {
  path: string;
  status: number | null;
  latencyMs: number;
  error?: string;
  semanticStatus?: StatusHealthValue;
  semanticDetail?: string | null;
  semanticScope?: "health" | "status" | "freshness";
}
