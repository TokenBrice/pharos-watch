import { z } from "zod";
import type { StatusHealthValue } from "./core";
import { ActivePriceCoverageHealthSchema, StablecoinPublicationHealthSchema, StatusHealthValueSchema } from "./core";
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

/**
 * Public status components: the reader-facing projection of the public health
 * inputs (`shared/lib/public-status-components.ts` owns the mapping). The
 * component vocabulary and state ladder live here once; labels and colours
 * live in `shared/lib/classification/operational-status.ts`.
 */
export const PUBLIC_STATUS_COMPONENT_IDS = [
  "website-api",
  "stablecoin-data",
  "charts",
  "risk-signals",
  "liquidity",
  "yield",
  "mint-burn",
  "blacklist",
  "data-refresh",
] as const;
export type PublicStatusComponentId = (typeof PUBLIC_STATUS_COMPONENT_IDS)[number];

/** Ordered by severity: delayed is inside its grace budget, outage is past it or unservable. */
export const PUBLIC_COMPONENT_STATES = ["operational", "delayed", "degraded", "outage"] as const;
export type PublicComponentState = (typeof PUBLIC_COMPONENT_STATES)[number];

export const PUBLIC_HEADLINE_STATES = ["operational", "delayed", "degraded", "partial-outage", "major-outage"] as const;
export type PublicHeadlineState = (typeof PUBLIC_HEADLINE_STATES)[number];

/** Age budgets for a freshness-graded component, named so the verdict carries its basis (R3). */
export const PublicComponentBudgetSchema = z.object({
  delayedAfterSec: z.number().positive(),
  degradedAfterSec: z.number().positive(),
  outageAfterSec: z.number().positive(),
});
export type PublicComponentBudget = z.output<typeof PublicComponentBudgetSchema>;

export const PublicStatusComponentSchema = z.object({
  id: z.enum(PUBLIC_STATUS_COMPONENT_IDS),
  state: z.enum(PUBLIC_COMPONENT_STATES),
  /** One plain sentence on what readers see; empty only when operational. */
  summary: z.string(),
  /** Machine-readable reasons behind a non-operational state (R4); empty when operational. */
  reasons: z.array(z.string()),
  /** Age of the freshest-graded input in seconds; null when not age-graded or unreadable. */
  ageSeconds: z.number().nonnegative().nullable(),
  budget: PublicComponentBudgetSchema.nullable(),
  /** When this state began, from the persisted public projection; null when unknown. */
  since: z.number().nullable(),
});
export type PublicStatusComponent = z.output<typeof PublicStatusComponentSchema>;

export const PublicStatusHeadlineSchema = z.object({
  state: z.enum(PUBLIC_HEADLINE_STATES),
  title: z.string(),
  /** Non-operational component ids, worst first. */
  affected: z.array(z.enum(PUBLIC_STATUS_COMPONENT_IDS)),
});
export type PublicStatusHeadline = z.output<typeof PublicStatusHeadlineSchema>;

export const PublicStatusTransitionComponentSchema = z.object({
  id: z.enum(PUBLIC_STATUS_COMPONENT_IDS),
  state: z.enum(PUBLIC_COMPONENT_STATES),
  reasons: z.array(z.string()),
});
export type PublicStatusTransitionComponent = z.output<typeof PublicStatusTransitionComponentSchema>;

export const PublicStatusTransitionSchema = z
  .object({
    id: z.number(),
    from: StatusHealthValueSchema.nullable(),
    to: StatusHealthValueSchema,
    transitionType: z.enum(["degrade", "recover", "init"]),
    reason: z.string(),
    at: z.number(),
    /**
     * `public` rows are persisted public-projection changes; `legacy` rows are
     * operator state-machine transitions filtered to public-impact causes,
     * served only for the period before the first public row.
     */
    source: z.enum(["public", "legacy"]).optional(),
    /** Public rows only: the headline after this change. */
    headline: PublicStatusHeadlineSchema.optional(),
    /** Public rows only: every non-operational component after this change. */
    components: z.array(PublicStatusTransitionComponentSchema).optional(),
  })
  .passthrough();
export type PublicStatusTransition = z.output<typeof PublicStatusTransitionSchema>;

export const PublicStatusHistoryResponseSchema = z
  .object({
    timestamp: z.number(),
    currentStatus: StatusHealthValueSchema,
    lastChangedAt: z.number().nullable(),
    transitions: z.array(PublicStatusTransitionSchema),
    /** Earliest persisted public-projection row; legacy rows cover only time before it. */
    publicHistoryStartedAt: z.number().nullable().optional(),
    /** True when the window holds more rows than `limit` returned (R7). */
    hasMore: z.boolean().optional(),
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
    totalEvents: z.number().nullable(),
    missingAmounts: z.number().nullable(),
    recentMissingAmounts: z.number().nullable(),
    recentWindowSec: z.number().nullable(),
    missingRatio: z.number().nullable(),
    unavailableReason: z.enum(["db-unavailable", "blacklist-read-failed"]).nullable().optional(),
  }),
  mintBurn: z.object({
    totalEvents: z.number().nullable(),
    latestEventTs: z.number().nullable(),
    latestHourlyTs: z.number().nullable(),
    freshnessAgeSec: z.number().nullable(),
    majorStaleCount: z.number().nullable(),
    staleMajorSymbols: z.array(z.string()).nullable(),
    unavailableReason: z.enum(["db-unavailable", "mint-burn-read-failed", "mint-burn-output-read-failed"]).nullable().optional(),
    queryErrors: MintBurnHealthQueryErrorsSchema.optional(),
    sync: z.object({
      lastSuccessfulSyncAt: z.number().nullable(),
      freshnessStatus: FreshnessStatusSchema.nullable(),
      warning: z.string().nullable(),
      criticalLaneHealthy: z.boolean().nullable(),
    }),
  }),
  circuits: z.record(z.string(), CircuitRecordSchema).nullable(),
  circuitsUnavailableReason: z.enum(["db-unavailable", "circuits-read-failed"]).nullable().optional(),
  stablecoinPublication: StablecoinPublicationHealthSchema.optional(),
  activePriceCoverage: ActivePriceCoverageHealthSchema.optional(),
  schedulerLiveness: SchedulerLivenessSchema.optional(),
  telegramSummary: TelegramHealthSummarySchema.nullable().optional(),
  /**
   * Reader-facing verdict. `status` stays the worst raw input (compatibility);
   * `headline` and `components` are the public projection the status page shows.
   */
  headline: PublicStatusHeadlineSchema.optional(),
  components: z.array(PublicStatusComponentSchema).optional(),
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
