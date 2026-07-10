import { z } from "zod";

interface TelegramBotTopStablecoin {
  stablecoinId: string;
  symbol: string;
  subscribers: number;
  explicitSubscribers?: number;
  presetImpliedSubscribers?: number;
}

export interface TelegramPendingDeliveryBacklog {
  claimable?: number;
  due: number;
  deferred: number;
  expired: number;
  nearTtl?: number;
  sending?: number;
  executionUnknown?: number;
  pendingExecutionUnknown?: number;
  freshExecutionUnknown?: number;
  oldestExecutionUnknownAgeSec?: number | null;
  executionUnknownSampleLimit?: number;
  executionUnknownLowerBound?: boolean;
  sentCleanup?: number;
  /** @deprecated Use `sentCleanup`. */
  completedPendingCleanup?: number;
}

export interface TelegramWatcherLifecycleSnapshot {
  date: string;
  snapshotAt: number;
  activeWatchers: number;
  newWatchers: number;
  churnedWatchers: number;
  reactivatedWatchers: number;
  explicitCoinFollows: number;
  presetImpliedCoinFollows: number;
  activePresetFollowers: number;
  alertTypeOptIns: TelegramAlertTypeChats;
  quietHoursEnabledChats: number;
  pendingDeliveries: number;
}

export interface TelegramWebhookEffectLifecycle {
  planned: number;
  started: number;
  executionUnknown: number;
  oldestPlannedAgeSec: number | null;
  oldestAmbiguousAgeSec: number | null;
  sampleLimit: number;
  lowerBound: boolean;
}

export interface TelegramBotStats {
  totalChats: number;
  alertEnabledChats: number;
  deliverableChats: number;
  subscribedChats: number;
  emptyAlertChats: number;
  mutedChatsWithSubscriptions: number;
  totalSubscriptions: number;
  explicitCoinSubscriptions?: number;
  presetImpliedCoinSubscriptions?: number;
  activePresetFollowers?: number;
  avgSubscriptionsPerSubscribedChat: number;
  pendingDisambiguations: number;
  pendingDeliveries: number;
  lastSubscriberActivityAt: number | null;
  customPreferenceChats: number;
  quietHoursEnabledChats: number;
  alertTypeChats: TelegramAlertTypeChats;
  topStablecoins: TelegramBotTopStablecoin[];
  oldestPendingDeliveryAgeSec?: number | null;
  oldestDuePendingAgeSec?: number | null;
  estimatedDrainTimeSec?: number;
  retryErrorClassCounts?: Record<string, number>;
  pendingDeliveryBacklog?: TelegramPendingDeliveryBacklog;
  webhookEffectUnknown?: number;
  webhookEffectLifecycle?: TelegramWebhookEffectLifecycle;
  presetQueryFailures?: number;
  /**
   * Number of inactive subscribers cleaned up in the trailing 7-day window
   * by the `telegram-inactive-cleanup` weekly cron. `null` when the cron has
   * not produced a successful run within the window (e.g. fresh deploy).
   */
  inactiveSubscribersCleanedThisWeek?: number | null;
  lifecycleSnapshot?: TelegramWatcherLifecycleSnapshot;
  quality?: TelegramTelemetryQuality;
}

export interface TelegramAlertTypeChats {
  dews: number;
  depeg: number;
  safety: number;
  launch: number;
  reserve: number;
  allTypes: number;
}

const TelegramTelemetryQualitySchema = z.object({
  status: z.enum(["complete", "partial"]),
  unavailableFields: z.array(z.string()),
  errors: z.record(z.string(), z.string()).optional(),
});
export type TelegramTelemetryQuality = z.infer<typeof TelegramTelemetryQualitySchema>;

const TelegramPulsePrivacySchema = z.object({
  exactActiveWatchers: z.boolean(),
  lowCardinalityThreshold: z.number(),
  suppressedFields: z.array(z.string()),
});
export type TelegramPulsePrivacy = z.infer<typeof TelegramPulsePrivacySchema>;

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

export interface TelegramDispatchEventsDetected {
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
export const TELEGRAM_ALERT_TYPES = ["dews", "depeg", "safety", "launch", "reserve"] as const;
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

export type PerAlertTypeDelivery = Record<TelegramAlertType, PerAlertTypeDeliveryStats>;

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

export type ParsedTelegramDispatchEventsDetected = {
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
