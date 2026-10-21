import { z } from "zod";
import { ReportCardGradeSchema } from "../report-card-grade";
import {
  V9RatingStatusSchema,
  V9CompactPartialEvidenceSchema,
  refineV9RatingStatusFields,
} from "../safety-score-v9-causes";
import {
  SafetyScorePublicationIdentitySchema,
  SafetyScoreV9PublicationIdentitySchema,
} from "../safety-score-publication";

const AlertSafetyPillarSchema = z.object({
  score: z.number().finite().nullable(),
  evidenceLevel: z.string(),
  freshness: z.string(),
});
export const AlertSafetyV9ExplainSnapshotSchema = z.object({
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
  /** Card reason codes; absent on baselines written before 2026-10-21. */
  reasonCodes: z.array(z.string()).optional(),
  bindingCap: z.object({ kind: z.string(), limit: z.number().finite(), reason: z.string() }).nullable(),
  weakestPillar: z.object({ pillar: z.string(), score: z.number().finite() }).nullable(),
  pillars: z.object({
    backing: AlertSafetyPillarSchema,
    exit: AlertSafetyPillarSchema,
    control: AlertSafetyPillarSchema,
  }),
});
export type AlertSafetyV9ExplainSnapshot = z.output<typeof AlertSafetyV9ExplainSnapshotSchema>;

/** Persisted rows require explanations, even though reason rendering can fall back. */
export const AlertSafetySourceRowSchema = z.object({
  grade: ReportCardGradeSchema.nullable(),
  score: z.number().min(0).max(100).nullable(),
  ratingStatus: V9RatingStatusSchema,
  partialEvidence: V9CompactPartialEvidenceSchema.nullable(),
  methodologyVersion: z.string().nullable(),
  operationallyAffected: z.boolean().optional(),
  /** Set on a baseline row held for a suppressed availability move (unix sec). */
  heldSinceSec: z.number().int().nonnegative().optional(),
  v9Explain: AlertSafetyV9ExplainSnapshotSchema,
}).superRefine(refineV9RatingStatusFields);
export type AlertSafetySourceRow = z.output<typeof AlertSafetySourceRowSchema>;
export const AlertSafetySourceSnapshotSchema = z.record(z.string().min(1), AlertSafetySourceRowSchema);
export type AlertSafetySourceSnapshot = z.output<typeof AlertSafetySourceSnapshotSchema>;

export const AlertSafetySnapshotEnvelopeSchema = z.object({
  generation: z.string(),
  safetyScoreIdentity: SafetyScorePublicationIdentitySchema,
  snapshot: AlertSafetySourceSnapshotSchema,
});
export type AlertSafetySnapshotEnvelope = z.output<typeof AlertSafetySnapshotEnvelopeSchema>;
export const AlertSafetySourceEnvelopeSchema = z.object({
  generation: AlertSafetySnapshotEnvelopeSchema.shape.generation,
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
  publicationGenerationId: z.string(),
  methodologyVersion: z.string(),
  publishedAt: z.number().finite(),
  snapshot: AlertSafetySourceSnapshotSchema,
});
export type AlertSafetySourceEnvelope = z.output<typeof AlertSafetySourceEnvelopeSchema>;

/** Preference values only; DEWS band classification remains owned by classification/risk. */
export const TELEGRAM_DEWS_BANDS = ["ALERT", "WARNING", "DANGER"] as const;
export const TELEGRAM_SAFETY_MODES = ["all", "downgrade-only", "upgrade-only"] as const;
export const TELEGRAM_DEPEG_STEPS = [100, 250, 500] as const;
export const TelegramDewsBandSchema = z.enum(TELEGRAM_DEWS_BANDS);
export const TelegramSafetyModeSchema = z.enum(TELEGRAM_SAFETY_MODES);
export const TelegramDepegStepBpsSchema = z.union(TELEGRAM_DEPEG_STEPS.map((step) => z.literal(step)));
export type TelegramDewsBand = z.output<typeof TelegramDewsBandSchema>;
export type TelegramSafetyMode = z.output<typeof TelegramSafetyModeSchema>;
export type TelegramDepegStepBps = z.output<typeof TelegramDepegStepBpsSchema>;

export function isDepegStepValue(value: unknown): value is TelegramDepegStepBps {
  return typeof value === "number" && (TELEGRAM_DEPEG_STEPS as readonly number[]).includes(value);
}

export function isTelegramSafetyMode(value: unknown): value is TelegramSafetyMode {
  return typeof value === "string" && (TELEGRAM_SAFETY_MODES as readonly string[]).includes(value);
}

export const ReserveAlertObservationsSchema = z.record(z.string().min(1), z.number().int().positive());
export const AlertReserveSourceEnvelopeSchema = z.object({
  generation: z.string().min(1),
  publishedAt: z.number().int().positive(),
  continuous: z.boolean(),
  driftIds: z.array(z.string().min(1)),
  observedSince: ReserveAlertObservationsSchema,
  unavailableIds: z.array(z.string().min(1)),
}).superRefine((value, ctx) => {
  if (new Set(value.driftIds).size !== value.driftIds.length ||
    value.driftIds.some((id) => value.observedSince[id] == null) ||
    new Set(value.unavailableIds).size !== value.unavailableIds.length ||
    value.unavailableIds.some((id) => value.observedSince[id] != null) ||
    Object.values(value.observedSince).some((since) => since > value.publishedAt)) {
    ctx.addIssue({ code: "custom", message: "invalid reserve observation census" });
  }
});
export type AlertReserveSourceEnvelope = z.infer<typeof AlertReserveSourceEnvelopeSchema>;

export const TelegramTelemetryQualitySchema = z.object({
  status: z.enum(["complete", "partial", "unknown"]),
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
  newWatchers: z.number().nullable(),
  churnedWatchers: z.number().nullable(),
  reactivatedWatchers: z.number().nullable(),
  explicitCoinFollows: z.number(),
  presetImpliedCoinFollows: z.number().nullable(),
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
  totalSubscriptions: z.number().nullable(),
  explicitCoinSubscriptions: z.number().optional(),
  presetImpliedCoinSubscriptions: z.number().nullable().optional(),
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


export const TelegramPulsePrivacySchema = z.object({
  exactActiveWatchers: z.boolean(),
  lowCardinalityThreshold: z.number(),
  suppressedFields: z.array(z.string()),
});
export type TelegramPulsePrivacy = z.infer<typeof TelegramPulsePrivacySchema>;
export const TelegramWatcherHistoryPointSchema = z.object({
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
  coinSubscriptions: z.number().nullable(),
  explicitCoinSubscriptions: z.number().optional(),
  presetImpliedCoinSubscriptions: z.number().nullable().optional(),
  activePresetFollowers: z.number().optional(),
  newWatchersToday: z.number().nullable().optional(),
  churnedWatchersToday: z.number().nullable().optional(),
  reactivatedWatchersToday: z.number().nullable().optional(),
  historySource: z.literal("snapshot").optional(),
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
  quality: pulse.quality ?? { status: "unknown" as const, unavailableFields: [] },
  privacy: pulse.privacy ?? { exactActiveWatchers: true, lowCardinalityThreshold: 5, suppressedFields: [] },
}));
export type TelegramPulse = z.infer<typeof TelegramPulseSchema>;

/**
 * What the route serves after the transform above applies its defaults. The artifact
 * registry registers this directly, so adding a field to the base is documented without a
 * second edit; only the defaulted fields are restated here.
 */
export const TelegramPulseOutputSchema = TelegramPulseBaseSchema.extend({
  currentSnapshotAt: z.number(),
  lifecycleHistoryUpdatedAt: z.number().nullable(),
  lifecycleHistoryEverySeconds: z.number(),
  quality: TelegramTelemetryQualitySchema,
  privacy: TelegramPulsePrivacySchema,
});

interface TelegramDispatchEventsDetected {
  dews: number;
  depeg: number;
  depegTriggered: number;
  depegResolved: number;
  depegWorsening: number;
  safety: number;
  launch: number;
  reserve: number;
  freeze: number;
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
  safetyAlertsSuppressed: boolean | null;
  safetyAlertSourceGeneration: string | null;
}

export interface ReserveAlertFieldsNullable {
  reserveAlertSourceState: ReserveAlertSourceState | null;
  reserveAlertSourceAgeSeconds: number | null;
  reserveAlertsSuppressed: boolean | null;
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
}

type ParsedTelegramDispatchEventsDetected = {
  [K in keyof TelegramDispatchEventsDetected]: number | null;
};

export interface TelegramDispatchCronMetadata extends SafetyAlertFieldsNullable, ReserveAlertFieldsNullable {
  subscribersNotified: number | null;
  messagesSent: number | null;
  blockedUsersCleanedUp: number | null;
  blockedUsersCleanupFailed: number | null;
  cappedAtLimit: boolean | null;
  snapshotSeeded: boolean | null;
  eventlessFastPath: boolean | null;
  skipped: string | null;
  /** Durable freeze recipient work considered this run; null for legacy metadata. */
  freezeTargetCount: number | null;
  pendingAttempted: number | null;
  pendingDrained: number | null;
  pendingRetryQueued: number | null;
  pendingDropped: number | null;
  pendingDroppedTtlExpired: number | null;
  pendingDroppedPermanentFailure: number | null;
  pendingDroppedMaxAttemptsFallback: number | null;
  pendingDeferred: number | null;
  pendingRateLimited: boolean | null;
  pendingRetryAfterSec: number | null;
  pendingEnqueued: number | null;
  pendingExpired: number | null;
  chatsWithActiveSnooze: number | null;
  presetQueryFailures: number | null;
  presetResolutionFailures: number | null;
  presetFailure: boolean | null;
  suppressedSafetyChangesAtSeed: number | null;
  eventsDetected: ParsedTelegramDispatchEventsDetected | null;
  /** Row-backed workload for the source evaluated by this dispatch run. */
  authoritativePlanning: {
    sourceEventId: string | null;
    sourceEventFamilies: TelegramAlertType[] | null;
    plannedTargetCount: number | null;
  } | null;
}
