import { z } from "zod";

const TelegramTelemetryQualitySchema = z.object({
  status: z.enum(["complete", "partial"]),
  unavailableFields: z.array(z.string()),
  errors: z.record(z.string(), z.string()).optional(),
});

const TelegramBotTopStablecoinSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  subscribers: z.number(),
  explicitSubscribers: z.number().optional(),
  presetImpliedSubscribers: z.number().optional(),
});

export const TelegramPendingDeliveryBacklogSchema = z.object({
  claimable: z.number().optional(),
  due: z.number(),
  deferred: z.number(),
  expired: z.number(),
  nearTtl: z.number().optional(),
  sending: z.number().optional(),
  /** Pending-table rows whose delivery effect is currently in flight. */
  pendingSending: z.number().optional(),
  /** Authoritative fresh-target rows whose direct delivery effect is in flight. */
  freshSending: z.number().optional(),
  executionUnknown: z.number().optional(),
  pendingExecutionUnknown: z.number().optional(),
  freshExecutionUnknown: z.number().optional(),
  oldestExecutionUnknownAgeSec: z.number().nullable().optional(),
  executionUnknownSampleLimit: z.number().optional(),
  executionUnknownLowerBound: z.boolean().optional(),
  sentCleanup: z.number().optional(),
});
export type TelegramPendingDeliveryBacklog = z.output<typeof TelegramPendingDeliveryBacklogSchema>;

export const TelegramAlertTypeChatsSchema = z.object({
  dews: z.number(),
  depeg: z.number(),
  safety: z.number(),
  launch: z.number(),
  reserve: z.number(),
  freeze: z.number().optional(),
  allTypes: z.number(),
});
export type TelegramAlertTypeChats = z.output<typeof TelegramAlertTypeChatsSchema>;

const TelegramWatcherLifecycleSnapshotSchema = z.object({
  date: z.string(),
  snapshotAt: z.number(),
  activeWatchers: z.number(),
  newWatchers: z.number(),
  churnedWatchers: z.number(),
  reactivatedWatchers: z.number(),
  explicitCoinFollows: z.number(),
  presetImpliedCoinFollows: z.number(),
  activePresetFollowers: z.number(),
  alertTypeOptIns: TelegramAlertTypeChatsSchema,
  quietHoursEnabledChats: z.number(),
  pendingDeliveries: z.number(),
});

const TelegramWebhookEffectLifecycleSchema = z.object({
  planned: z.number(),
  started: z.number(),
  executionUnknown: z.number(),
  oldestPlannedAgeSec: z.number().nullable(),
  oldestAmbiguousAgeSec: z.number().nullable(),
  sampleLimit: z.number(),
  lowerBound: z.boolean(),
});

const TelegramPersonalizedRecapTelemetrySchema = z.object({
  enabledPrivateChats: z.number(),
  due: z.number(),
  queued: z.number(),
  executionUnknown: z.number(),
  oldestDueAgeSec: z.number().nullable(),
  oldestQueuedAgeSec: z.number().nullable(),
  oldestExecutionUnknownAgeSec: z.number().nullable(),
});

export const TELEGRAM_DELIVERY_SLI_EVIDENCE_QUALITY_VALUES = ["complete", "partial", "empty"] as const;
export type TelegramDeliverySliEvidenceQuality =
  (typeof TELEGRAM_DELIVERY_SLI_EVIDENCE_QUALITY_VALUES)[number];

const TelegramDeliverySliEvidenceFreshnessSchema = z.enum(["fresh", "stale", "empty"]);

export const TelegramDeliveryLatencySliSchema = z.object({
  eligibleCount: z.number(),
  observedCount: z.number(),
  averageSec: z.number().nullable(),
  maximumSec: z.number().nullable(),
  quality: z.enum(TELEGRAM_DELIVERY_SLI_EVIDENCE_QUALITY_VALUES),
});
export type TelegramDeliveryLatencySli = z.output<typeof TelegramDeliveryLatencySliSchema>;

export const TelegramDeliverySliReasonCountSchema = z.object({
  reason: z.string(),
  count: z.number(),
});
export type TelegramDeliverySliReasonCount = z.output<typeof TelegramDeliverySliReasonCountSchema>;

export const TelegramDeliverySliBacklogBucketSchema = z.object({
  priority: z.number(),
  ageBucket: z.enum(["lt_5m", "5m_15m", "15m_1h", "1h_6h", "gte_6h"]),
  count: z.number(),
  oldestAgeSec: z.number(),
  nearestTtlSec: z.number().nullable(),
});
export type TelegramDeliverySliBacklogBucket = z.output<typeof TelegramDeliverySliBacklogBucketSchema>;

export const TelegramDeliverySliRollupSchema = z.object({
  window: z.object({
    generatedAt: z.number(),
    startsAt: z.number(),
    endsAt: z.number(),
    lookbackSec: z.number(),
    bounded: z.literal(true),
  }),
  evidence: z.object({
    latestAt: z.number().nullable(),
    ageSec: z.number().nullable(),
    freshness: TelegramDeliverySliEvidenceFreshnessSchema,
    freshnessThresholdSec: z.number(),
  }),
  detectionToPlan: TelegramDeliveryLatencySliSchema,
  planToTelegramAcceptance: TelegramDeliveryLatencySliSchema,
  telegramAcceptanceBeforeTtl: z.object({
    telegramAcceptedCount: z.number(),
    knownTtlCount: z.number(),
    acceptedBeforeTtlCount: z.number(),
    acceptedAfterTtlCount: z.number(),
    rate: z.number().nullable(),
    quality: z.enum(TELEGRAM_DELIVERY_SLI_EVIDENCE_QUALITY_VALUES),
  }),
  authoritativeTargetOutcomes: z.object({
    total: z.number(),
    telegramAccepted: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    expired: z.number(),
    executionUnknown: z.number(),
    unresolved: z.number(),
    telegramAcceptanceRate: z.number().nullable(),
  }),
  familyAttribution: z.object({
    dews: z.number(),
    depeg: z.number(),
    safety: z.number(),
    launch: z.number(),
    reserve: z.number(),
    freeze: z.number(),
    mixed: z.number(),
    unknown: z.number(),
  }),
  preferenceChangeCancellations: z.object({
    count: z.number(),
    reasons: z.array(TelegramDeliverySliReasonCountSchema),
    reasonsTruncated: z.boolean(),
  }),
  backlog: z.object({
    windowStartsAt: z.number(),
    windowBounded: z.literal(true),
    count: z.number(),
    oldestAgeSec: z.number().nullable(),
    buckets: z.array(TelegramDeliverySliBacklogBucketSchema),
  }),
  observedTargetErrorReasons: z.object({
    reasons: z.array(TelegramDeliverySliReasonCountSchema),
    truncated: z.boolean(),
  }),
  executionUnknown: z.object({
    count: z.number(),
    oldestAgeSec: z.number().nullable(),
    olderThan15mCount: z.number(),
  }),
  deadLetters: z.object({
    count: z.number(),
    totalAttempts: z.number(),
    reasons: z.array(TelegramDeliverySliReasonCountSchema),
    reasonsTruncated: z.boolean(),
    lastErrorReasons: z.array(TelegramDeliverySliReasonCountSchema),
    lastErrorReasonsTruncated: z.boolean(),
  }),
});
export type TelegramDeliverySliRollup = z.output<typeof TelegramDeliverySliRollupSchema>;

export const TelegramDeliverySliStatusSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    quality: z.enum(TELEGRAM_DELIVERY_SLI_EVIDENCE_QUALITY_VALUES),
    freshness: TelegramDeliverySliEvidenceFreshnessSchema,
    acceptanceDefinition: z.literal("telegram_bot_api_accepted_not_user_receipt"),
    rollup: TelegramDeliverySliRollupSchema,
  }),
  z.object({
    availability: z.literal("unavailable"),
    quality: z.literal("unavailable"),
    freshness: z.literal("unknown"),
    acceptanceDefinition: z.literal("telegram_bot_api_accepted_not_user_receipt"),
    rollup: z.null(),
    error: z.object({
      code: z.literal("telegram_delivery_sli_query_failed"),
      message: z.string(),
    }),
  }),
]);
export type TelegramDeliverySliStatus = z.output<typeof TelegramDeliverySliStatusSchema>;

export const TelegramBotStatsSchema = z.object({
  totalChats: z.number(),
  alertEnabledChats: z.number(),
  deliverableChats: z.number(),
  subscribedChats: z.number(),
  emptyAlertChats: z.number(),
  mutedChatsWithSubscriptions: z.number(),
  totalSubscriptions: z.number(),
  explicitCoinSubscriptions: z.number().optional(),
  presetImpliedCoinSubscriptions: z.number().optional(),
  activePresetFollowers: z.number().optional(),
  avgSubscriptionsPerSubscribedChat: z.number(),
  pendingDisambiguations: z.number(),
  pendingDeliveries: z.number(),
  lastSubscriberActivityAt: z.number().nullable(),
  customPreferenceChats: z.number(),
  quietHoursEnabledChats: z.number(),
  alertTypeChats: TelegramAlertTypeChatsSchema,
  topStablecoins: z.array(TelegramBotTopStablecoinSchema),
  oldestPendingDeliveryAgeSec: z.number().nullable().optional(),
  oldestDuePendingAgeSec: z.number().nullable().optional(),
  estimatedDrainTimeSec: z.number().optional(),
  retryErrorClassCounts: z.record(z.string(), z.number()).optional(),
  pendingDeliveryBacklog: TelegramPendingDeliveryBacklogSchema.optional(),
  webhookEffectUnknown: z.number().optional(),
  webhookEffectLifecycle: TelegramWebhookEffectLifecycleSchema.optional(),
  personalizedRecap: TelegramPersonalizedRecapTelemetrySchema.optional(),
  deliverySli: TelegramDeliverySliStatusSchema,
  presetQueryFailures: z.number().optional(),
  /**
   * Number of inactive subscribers cleaned up in the trailing 7-day window
   * by the `telegram-inactive-cleanup` weekly cron. `null` when the cron has
   * not produced a successful run within the window (e.g. fresh deploy).
   */
  inactiveSubscribersCleanedThisWeek: z.number().nullable().optional(),
  lifecycleSnapshot: TelegramWatcherLifecycleSnapshotSchema.optional(),
  quality: TelegramTelemetryQualitySchema.optional(),
});
export type TelegramBotStats = z.output<typeof TelegramBotStatsSchema>;


const TelegramPulsePrivacySchema = z.object({
  exactActiveWatchers: z.boolean(),
  lowCardinalityThreshold: z.number(),
  suppressedFields: z.array(z.string()),
});
const TelegramWatcherHistoryPointSchema = z.object({
  date: z.string(),
  timestamp: z.number(),
  snapshotAt: z.number().nullable().optional(),
  newWatchers: z.number().nullable().optional(),
  activeWatchers: z.number(),
  churnedWatchers: z.number().nullable().optional(),
  reactivatedWatchers: z.number().nullable().optional(),
});
export type TelegramWatcherHistoryPoint = z.infer<typeof TelegramWatcherHistoryPointSchema>;

const TelegramPulseBaseSchema = z.object({
  activeWatchers: z.number(),
  coinSubscriptions: z.number(),
  explicitCoinSubscriptions: z.number().optional(),
  presetImpliedCoinSubscriptions: z.number().optional(),
  activePresetFollowers: z.number().optional(),
  newWatchersToday: z.number().nullable().optional(),
  churnedWatchersToday: z.number().nullable().optional(),
  reactivatedWatchersToday: z.number().nullable().optional(),
  historySource: z.enum(["snapshot", "live-fallback"]).optional(),
  topCoins: z.array(z.string()),
  watcherHistory: z.array(TelegramWatcherHistoryPointSchema),
  pendingDeliveries: z.number().nullable(),
  miniAppSessionsToday: z.number().nullable().optional(),
  miniAppMutationsToday: z.number().nullable().optional(),
  miniAppDeniedToday: z.number().nullable().optional(),
  miniAppReplayClaimsToday: z.number().nullable().optional(),
  miniAppOpenToFirstMutationP50Sec: z.number().nullable().optional(),
  currentSnapshotAt: z.number().optional(),
  lifecycleHistoryUpdatedAt: z.number().nullable().optional(),
  lifecycleHistoryEverySeconds: z.number().optional(),
  quality: TelegramTelemetryQualitySchema.optional(),
  privacy: TelegramPulsePrivacySchema.optional(),
  updatedAt: z.number(),
  updatedEverySeconds: z.number(),
});

export const TelegramPulseSchema = TelegramPulseBaseSchema.transform((pulse) => ({
  ...pulse,
  currentSnapshotAt: pulse.currentSnapshotAt ?? pulse.updatedAt,
  lifecycleHistoryUpdatedAt: pulse.lifecycleHistoryUpdatedAt ?? null,
  lifecycleHistoryEverySeconds: pulse.lifecycleHistoryEverySeconds ?? 900,
  quality: pulse.quality ?? { status: "complete" as const, unavailableFields: [] },
  privacy: pulse.privacy ?? { exactActiveWatchers: true, lowCardinalityThreshold: 5, suppressedFields: [] },
}));
export type TelegramPulse = z.infer<typeof TelegramPulseSchema>;

interface TelegramDispatchEventsDetected {
  dews: number;
  depeg: number;
  depegTriggered: number;
  depegResolved: number;
  depegWorsening: number;
  safety: number;
  launch: number;
  reserve: number;
  suppressedMethodologyChanges: number;
}

/**
 * Canonical membership list for {@link TelegramAlertType}, ordered to match the
 * positional `alert_*`/`global_alert_*` columns in `telegram_subscribers`.
 * Use for iteration and membership checks; order-significant routing arrays
 * (e.g. ALERT_TYPE_PRIORITY) intentionally keep their own ordering.
 */
export const TELEGRAM_ALERT_TYPES = ["dews", "depeg", "safety", "launch", "reserve", "freeze"] as const;
/** The alert categories tracked by the Telegram dispatcher. */
export type TelegramAlertType = (typeof TELEGRAM_ALERT_TYPES)[number];

export function isTelegramAlertType(value: unknown): value is TelegramAlertType {
  return (TELEGRAM_ALERT_TYPES as readonly string[]).includes(value as string);
}

export interface PerAlertTypeDeliveryStats {
  sent: number;
  enqueued: number;
  failed: number;
  blocked: number;
  firstSendLatencyMs: number | null;
}

export type PerAlertTypeDelivery = Record<Exclude<TelegramAlertType, "freeze">, PerAlertTypeDeliveryStats> &
  Partial<Record<"freeze", PerAlertTypeDeliveryStats>>;

export const SAFETY_ALERT_SOURCE_STATE_VALUES = ["ok", "missing", "corrupt", "stale", "wrong-generation"] as const;
export type SafetyAlertSourceState = (typeof SAFETY_ALERT_SOURCE_STATE_VALUES)[number];

export const RESERVE_ALERT_SOURCE_STATE_VALUES = [
  "ok",
  "missing",
  "corrupt",
  "stale",
  "wrong-generation",
  "recovering",
] as const;
export type ReserveAlertSourceState = (typeof RESERVE_ALERT_SOURCE_STATE_VALUES)[number];

/**
 * The four nullable safety-alert source fields shared by the Telegram dispatch
 * cron metadata and Telegram health summary surfaces. The cron *result* type
 * has a non-null `safetyAlertSourceState`, so it cannot share this shape.
 */
export interface SafetyAlertFieldsNullable {
  safetyAlertSourceState: SafetyAlertSourceState | null;
  safetyAlertSourceAgeSeconds: number | null;
  safetyAlertsSuppressed: boolean;
  safetyAlertSourceGeneration: string | null;
}

export interface ReserveAlertFieldsNullable {
  reserveAlertSourceState: ReserveAlertSourceState | null;
  reserveAlertSourceAgeSeconds: number | null;
  reserveAlertsSuppressed: boolean;
  reserveAlertSourceGeneration: string | null;
}

export interface TelegramDispatchCronResult {
  subscribersNotified: number;
  messagesSent: number;
  blockedUsersCleanedUp: number;
  blockedUsersCleanupFailed: number;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
  eventlessFastPath?: boolean;
  skipped?: string | null;
  freshAttempted: number;
  freshSent: number;
  freshRetryQueued: number;
  freshPermanentFailures: number;
  freshDeferredPerChat: number;
  pendingAttempted: number;
  pendingDrained: number;
  pendingRetryQueued: number;
  pendingDropped: number;
  /** Pending rows dropped because they aged past `PENDING_TTL_SEC` (end-of-run cleanup). */
  pendingDroppedTtlExpired: number;
  /** Pending rows dropped after Telegram returned a non-retryable, non-blocked error. */
  pendingDroppedPermanentFailure: number;
  /** Pending rows dropped after hitting the defensive `PENDING_MAX_ATTEMPTS` ceiling. */
  pendingDroppedMaxAttemptsFallback: number;
  pendingDeferred: number;
  pendingRateLimited: boolean;
  pendingRetryAfterSec: number | null;
  pendingEnqueued: number;
  pendingExpired: number;
  chatsWithActiveSnooze: number;
  safetyAlertSourceState: SafetyAlertSourceState;
  safetyAlertSourceAgeSeconds: number | null;
  safetyAlertsSuppressed: boolean;
  safetyAlertSourceGeneration: string | null;
  reserveAlertSourceState: ReserveAlertSourceState;
  reserveAlertSourceAgeSeconds: number | null;
  reserveAlertsSuppressed: boolean;
  reserveAlertSourceGeneration: string | null;
  presetQueryFailures: number;
  presetResolutionFailures: number;
  presetFailure: boolean;
  /**
   * Count of safety-grade changes that would have been emitted but were
   * suppressed because the Telegram lane had to reseed its safety snapshot
   * (e.g. methodology-version flip changed the source generation). A
   * non-zero value signals real downgrades hidden by the seed and is a cue
   * for operators to inspect the safety-grade history directly.
   */
  suppressedSafetyChangesAtSeed: number;
  eventsDetected: TelegramDispatchEventsDetected;
  perAlertType: PerAlertTypeDelivery;
}

type ParsedTelegramDispatchEventsDetected = {
  [K in keyof TelegramDispatchEventsDetected]: number | null;
};

export interface TelegramDispatchCronMetadata extends SafetyAlertFieldsNullable, ReserveAlertFieldsNullable {
  subscribersNotified: number | null;
  messagesSent: number | null;
  blockedUsersCleanedUp: number | null;
  blockedUsersCleanupFailed: number | null;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
  eventlessFastPath: boolean;
  skipped: string | null;
  freshAttempted: number | null;
  freshSent: number | null;
  freshRetryQueued: number | null;
  freshPermanentFailures: number | null;
  freshDeferredPerChat: number | null;
  freshCandidateChats: number | null;
  freshCandidateCount: number | null;
  pendingAttempted: number | null;
  pendingDrained: number | null;
  pendingRetryQueued: number | null;
  pendingDropped: number | null;
  pendingDroppedTtlExpired: number | null;
  pendingDroppedPermanentFailure: number | null;
  pendingDroppedMaxAttemptsFallback: number | null;
  pendingDeferred: number | null;
  pendingRateLimited: boolean;
  pendingRetryAfterSec: number | null;
  pendingEnqueued: number | null;
  pendingExpired: number | null;
  chatsWithActiveSnooze: number | null;
  presetQueryFailures: number | null;
  presetResolutionFailures: number | null;
  presetFailure: boolean;
  suppressedSafetyChangesAtSeed: number | null;
  eventsDetected: ParsedTelegramDispatchEventsDetected | null;
  perAlertType: PerAlertTypeDelivery | null;
}
