import { z } from "zod";
import type { LiquidityCoverageClass } from "./market";
import type { MintBurnCoverageStatus } from "./mint-burn";
import type { DiscoveryCandidate } from "./discovery";
import type { PriceSourceHealth } from "./pricing-source-health";
import { ReserveCompositionOverviewSchema, type ReserveCompositionOverview } from "./live-reserves";

export type { DiscoveryCandidate, DiscoveryCandidatesResponse } from "./discovery";
export type {
  PriceSourceDepthBucket,
  PriceSourceDepthDistribution,
  PriceSourceHealth,
  PriceSourceHealthBucketKey,
} from "./pricing-source-health";

const CacheStatusSchema = z.object({
  ageSeconds: z.number().nullable(),
  maxAge: z.number(),
  healthy: z.boolean(),
  freshnessSource: z.enum(["freshness-sentinel", "table-fallback", "cron-fallback"]).optional(),
  sentinelValidationReason: z.string().nullable().optional(),
  producerJob: z.string().nullable().optional(),
  producerIntervalSec: z.number().nullable().optional(),
  endpointMaxAge: z.number().nullable().optional(),
  availabilityMaxAge: z.number().nullable().optional(),
  endpointBudgetReason: z.string().nullable().optional(),
  availabilityBudgetReason: z.string().nullable().optional(),
  mode: z.enum(["live", "cached-fallback"]).optional(),
  sourceUpdatedAt: z.number().nullable().optional(),
  sourceAgeSeconds: z.number().nullable().optional(),
  sourceStatus: z.enum(["fresh", "degraded", "stale", "none"]).optional(),
  warning: z.string().nullable().optional(),
  consecutiveFallbackRuns: z.number().optional(),
  upstreamProvider: z.string().nullable().optional(),
});
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

export const StatusHealthValueSchema = z.enum(["healthy", "degraded", "stale"]);
export type StatusHealthValue = z.infer<typeof StatusHealthValueSchema>;
const StatusHealthOrUnknownSchema = z.enum([...StatusHealthValueSchema.options, "unknown"]);
export type StatusHealthOrUnknown = z.infer<typeof StatusHealthOrUnknownSchema>;

export const CRON_RUN_STATUS_VALUES = [
  "ok",
  "degraded",
  "error",
  "skipped_locked",
  "skipped_neutral",
  "skipped_duplicate",
  "skipped_running",
] as const;
export const CronRunStatusSchema = z.enum(CRON_RUN_STATUS_VALUES);
export type CronRunStatus = z.infer<typeof CronRunStatusSchema>;

export interface CronRun {
  startedAt: number;
  durationMs: number;
  status: CronRunStatus;
  error?: string;
  itemCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CronInFlight {
  startedAt: number;
  updatedAt: number;
  stage?: string;
  itemsDone?: number;
  itemsTotal?: number;
  message?: string;
  leaseOwner?: string;
  metadata?: Record<string, unknown>;
  stale: boolean;
}

export interface CronStaleArtifact {
  kind: "expired-lease" | "orphaned-progress";
  job: string;
  leaseOwner?: string;
  leaseUntil?: number;
  progressUpdatedAt?: number;
  progressStage?: string;
  slotStartedAt?: number | null;
}

export interface CronEvent {
  event: "cron_event";
  job: string;
  eventType: string;
  severity: "info" | "warning" | "error";
  message: string;
  metadata?: Record<string, unknown>;
  recordedAt: number;
}

export const WORKER_JOB_ATTEMPT_STATE_VALUES = [
  "queued",
  "claimed",
  "running",
  "completed",
  "deferred",
  "abandoned",
  "failed",
  "skipped_locked",
  "cancelled",
] as const;
export type WorkerJobAttemptState = (typeof WORKER_JOB_ATTEMPT_STATE_VALUES)[number];

export const WORKER_JOB_ATTEMPT_STATUS_CLASS_VALUES = [
  "ok",
  "degraded",
  "controlled_error",
  "thrown_error",
  "abandoned",
  "deferred",
  "skipped_duplicate",
  "skipped_running",
  "skipped_locked",
] as const;
export type WorkerJobAttemptStatusClass = (typeof WORKER_JOB_ATTEMPT_STATUS_CLASS_VALUES)[number];

export interface WorkerJobAttemptStatus {
  attemptId: string;
  idempotencyKey: string;
  scheduleKey: string;
  job: string;
  slotStartedAt: number | null;
  producerKind: string;
  state: WorkerJobAttemptState;
  statusClass: WorkerJobAttemptStatusClass | null;
  attemptNo: number;
  owner: string | null;
  leaseUntil: number | null;
  queuedAt: number;
  claimedAt: number | null;
  startedAt: number | null;
  lastHeartbeatAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  durationMs: number | null;
  itemCount: number | null;
  stale: boolean;
  error: string | null;
  metadata?: Record<string, unknown>;
}

export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
  telemetryUnknown?: boolean;
  inFlight?: CronInFlight | null;
  latestAttempt?: WorkerJobAttemptStatus;
  staleArtifacts?: CronStaleArtifact[];
  latestEvent?: CronEvent;
  /**
   * Set to `true` only for watch-tier crons that have zero historical runs
   * (bootstrap state). The cron is considered healthy in this state because
   * its first successful run has not yet produced a `cron_runs` row, so
   * there is no history to compare against. Critical-tier crons do not get
   * this flag — they are unhealthy until they have produced at least one run.
   */
  bootstrap?: boolean;
}

export interface BudgetOnlySurfaceStatus {
  job: string;
  label: string;
  scheduleKey: string;
  schedule: string;
  expectedIntervalSec: number;
  maxAgeSec: number;
  maxConnections: number;
  connectionGroup?: string;
  telemetryStatus: "fresh" | "stale" | "missing" | "unreadable";
  telemetryUnknown: boolean;
  checkedAt: number | null;
  ageSeconds: number | null;
  durationMs: number | null;
  dueCount: number | null;
  processedCount: number | null;
  outcome: "ok" | "degraded" | "error" | "skipped" | "unknown";
  skippedReason?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export interface StatusCause {
  code: string;
  layer: "availability" | "data-quality" | "system";
  severity: "info" | "warning" | "critical";
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  /**
   * Optional operator-facing runbook link. Populated only for cause codes
   * that have a documented runbook — UI renders the link only when present.
   */
  runbookUrl?: string;
}

export interface StatusStateInfo {
  scope: "global";
  currentStatus: StatusHealthValue;
  rawStatus: StatusHealthValue;
  lastEvaluatedAt: number;
  lastChangedAt: number;
  minDwellSec: number;
  staleMinDwellSec: number;
  consecutiveRaw: {
    healthy: number;
    degraded: number;
    stale: number;
  };
  thresholds: {
    escalateToDegraded: number;
    escalateToStale: number;
    recoverToDegraded: number;
    recoverToHealthy: number;
  };
}

export interface StatusStaleness {
  ageSeconds: number;
  maxAgeSec: number;
  isStale: boolean;
}

export interface StatusProbeSummary {
  timestamp: number | null;
  status: StatusHealthOrUnknown;
  sampleCount: number;
  passCount: number;
  failCount: number;
  bootstrapMissCount?: number;
  p95LatencyMs: number | null;
  internal?: StatusProbePlaneSummary | null;
  external?: StatusProbePlaneSummary | null;
  internalExternalDiscrepancy?: StatusProbeComparison | null;
}

export interface StatusProbePlaneSummary {
  status: StatusHealthOrUnknown;
  sampleCount: number;
  passCount: number;
  failCount: number;
  p95LatencyMs: number | null;
  origins: string[];
}

export const STATUS_PROBE_COMPARISON_REASON_VALUES = [
  "in-sync",
  "internal-missing",
  "external-missing",
  "external-worse",
  "internal-worse",
] as const;
export type StatusProbeComparisonReason = (typeof STATUS_PROBE_COMPARISON_REASON_VALUES)[number];

export interface StatusProbeComparison {
  hasDivergence: boolean;
  severityDelta: number;
  internalStatus: StatusProbePlaneSummary["status"];
  externalStatus: StatusProbePlaneSummary["status"];
  reason: StatusProbeComparisonReason;
  details: string | null;
}

export const STATUS_DISCREPANCY_REASON_VALUES = [
  "in-sync",
  "probe-stale",
  "probe-disagrees",
  "probe-missing",
] as const;
export type StatusDiscrepancyReason = (typeof STATUS_DISCREPANCY_REASON_VALUES)[number];

export interface StatusDiscrepancy {
  hasDivergence: boolean;
  severityDelta: number;
  statusSeverity: number;
  probeSeverity: number;
  details: string | null;
  probeAgeSeconds: number | null;
  consecutiveDivergent: number;
  /**
   * Machine-readable classification so UI and alert logic can branch without
   * parsing `details`. Disambiguates "probe never ran" vs "probe ran but
   * disagrees" vs "probe is stale".
   */
  discrepancyReason: StatusDiscrepancyReason;
}

export interface StatusTransition {
  id: number;
  scope: "global";
  from: StatusHealthValue | null;
  to: StatusHealthValue;
  rawStatus: StatusHealthValue;
  transitionType: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causes: StatusCause[];
  at: number;
}

export interface DataQuality {
  stablecoinsCacheStatus: "ok" | "degraded" | "error";
  stablecoinsCacheReason: string | null;
  blacklistGapStatus: "ok" | "failed";
  activeDepegStatus: "ok" | "failed";
  onchainSupplyQueryStatus: "ok" | "failed" | "unavailable";
  repairDebt: RepairDebtSummary;
  ddrRepairDebtStatus: "ok" | "present" | "unknown";
  ddrRepairDebtCount: number;
  ddrRepairDebtCheckedAt: number | null;
  ddrRepairDebtEvents: Array<{
    eventId: number;
    reason: string;
  }>;
  ddrRepairDebtEventsTruncated: boolean;
  sourceFailures: Array<{
    source: "stablecoins-cache" | "blacklist-gaps" | "active-depegs" | "onchain-supply";
    message: string;
  }>;
  totalStablecoins: number;
  missingPrices: number;
  blacklistMissingAmounts: number;
  blacklistRecentMissingAmounts: number;
  blacklistRecentWindowSec: number;
  blacklistMissingRatio: number;
  blacklistTotal: number;
  blacklistOldestRecoverableAgeSec: number | null;
  blacklistNeverAttemptedCount: number;
  blacklistRepeatedFailureCount: number;
  onchainSupplyDivergences: number;
  onchainDivergenceRatio: number;
  onchainSupplyMonitoring: "active" | "unavailable";
  onchainSupplyLatestAt: number | null;
  onchainSupplyTrackedCoins: number;
  activeDepegs: number;
  staleOnchainSupply: number;
  onchainStaleRatio: number;
}

export interface RepairDebtKindSummary {
  openCount: number;
  oldestAgeSec: number | null;
  nextRunnerDueAt: number | null;
}

export interface RepairDebtSummary {
  status: "ok" | "present" | "unknown";
  openCount: number;
  oldestAgeSec: number | null;
  byKind: Record<string, RepairDebtKindSummary>;
  availabilityEscalated: boolean;
  nextRunnerDueAt: number | null;
  source: "worker-repair-tasks" | "worker-repair-tasks+ddr-cache-fallback" | "ddr-cache-fallback" | "unavailable";
}

export interface DatasetFreshness {
  stablecoins: number | null;
  blacklist: number | null;
  mintBurn: number | null;
  supply: number | null;
  safetyGrades: number | null;
  yield: number | null;
  depegs: number | null;
  dews: number | null;
  digest: number | null;
  discoveryCandidates: number | null;
}

interface TelegramBotTopStablecoin {
  stablecoinId: string;
  symbol: string;
  subscribers: number;
  explicitSubscribers?: number;
  presetImpliedSubscribers?: number;
}

export interface TelegramPendingDeliveryBacklog {
  due: number;
  deferred: number;
  expired: number;
  nearTtl?: number;
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

const SafetyAlertFieldsNullableSchemaShape = {
  safetyAlertSourceState: z.enum(SAFETY_ALERT_SOURCE_STATE_VALUES).nullable(),
  safetyAlertSourceAgeSeconds: z.number().nullable(),
  safetyAlertsSuppressed: z.boolean(),
  safetyAlertSourceGeneration: z.string().nullable(),
} as const;

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

export interface TelegramDispatchCronMetadata extends SafetyAlertFieldsNullable {
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

export interface LiquidityHealth {
  lastRunStatus: string | null;
  currentCoverage: number;
  previousCoverage: number | null;
  currentGlobalTvl: number | null;
  previousGlobalTvl: number | null;
  currentTop10CoveredTvl: number | null;
  previousTop10CoveredTvl: number | null;
  currentTop10GuardTvl: number | null;
  previousTop10GuardTvl: number | null;
  failedSources: string[];
  nearCoverageGuard: boolean;
  nearValueGuard: boolean;
  nearMajorCoverageGuard: boolean;
  currentCoverageClasses: Record<LiquidityCoverageClass, number>;
  previousCoverageClasses: Record<LiquidityCoverageClass, number>;
}

export type YieldHealthFieldStatus = StatusHealthOrUnknown;

export type YieldSourceRiskCoverageField =
  | "sourceRiskScore"
  | "sourceRiskPenalty"
  | "sourceDepthRatio"
  | "rewardShare"
  | "sourceAgeSeconds"
  | "observationCount30d"
  | "sourceSwitchCount30d"
  | "deploymentPlace"
  | "venueProtocol"
  | "venueChain"
  | "venueRiskTier";

export interface YieldSourceRiskFieldCoverage {
  eligibleCount: number;
  populatedCount: number;
  nullCount: number;
  coverageRatio: number;
  nullRate: number;
}

export interface YieldSourceRiskCoverageSummary {
  status: YieldHealthFieldStatus;
  threshold: number;
  totalRows: number;
  bestRows: number;
  altRows: number;
  rowsWithSourceRisk: number;
  fields: Record<YieldSourceRiskCoverageField, YieldSourceRiskFieldCoverage>;
}

export interface YieldComparisonAnchorFreshnessExample {
  stablecoinId: string;
  symbol: string;
  sourceKey: string;
  dataSource: string;
  anchorAgeSeconds: number;
  comparisonAnchorObservedAt: number;
}

export interface YieldComparisonAnchorFreshnessSummary {
  status: YieldHealthFieldStatus;
  anchoredRowCount: number | null;
  staleAnchorCount: number | null;
  oldestAnchorAgeSeconds: number | null;
  oldestAnchorStablecoinId: string | null;
  oldestAnchorSourceKey: string | null;
  staleAnchorExamples: YieldComparisonAnchorFreshnessExample[];
  staleAnchorExamplesTruncated: boolean;
}

export type YieldCoverageAuditQueueAction = "accept" | "dismiss" | "intentional-gap" | "watch";

export type YieldCoverageAuditQueueItemKind =
  | "manifest-missing"
  | "ranking-missing"
  | "unmatched-high-tvl-pool"
  | "missing-protocol"
  | "native-exact-pool"
  | "source-family-adapter"
  | "lending-allowlist"
  | "venue-risk-config-missing"
  | "stale-auto-lending-override"
  | "quarantine-ready-to-restore"
  | "stale-venue-risk-score";

export interface YieldCoverageAuditQueueItem {
  id: string;
  kind: YieldCoverageAuditQueueItemKind;
  title: string;
  detail: string;
  actionHint: YieldCoverageAuditQueueAction;
  stablecoinIds?: string[];
  project?: string;
  pool?: string;
  symbol?: string;
  chain?: string;
  tvlUsd?: number;
  apy?: number;
  poolCount?: number;
  totalTvlUsd?: number;
  recommendedTier?: "high-confidence" | "review-needed";
}

export interface YieldHealthSummary {
  status: Exclude<YieldHealthFieldStatus, "unknown">;
  statusImpact: "public-critical" | "admin-watch";
  runbookUrl: string;
  rankingCount: number | null;
  rankingCountDelta: number | null;
  previousRankingCount: number | null;
  rankingUpdatedAt: number | null;
  rankingAgeSec: number | null;
  rankingMaxAgeSec: number;
  rankingStatus: YieldHealthFieldStatus;
  safetyCoverage: {
    coveredCount: number | null;
    trackedCount: number | null;
    coverageRatio: number | null;
    threshold: number;
    status: YieldHealthFieldStatus;
    reason: string | null;
  };
  supplemental: {
    updatedAt: number | null;
    ageSec: number | null;
    maxAgeSec: number;
    status: YieldHealthFieldStatus;
    familyCount?: number;
    freshFamilyCount?: number;
    degradedFamilyCount?: number;
    staleFamilyCount?: number;
    missingFamilyCount?: number;
    families?: Record<string, {
      updatedAt: number | null;
      ageSec: number | null;
      sourceCount: number | null;
      status: YieldHealthFieldStatus;
    }>;
  };
  benchmark: {
    fetchedAt: number | null;
    ageSec: number | null;
    maxAgeSec: number;
    source: string | null;
    isFallback: boolean | null;
    fallbackMode: string | null;
    status: YieldHealthFieldStatus;
  };
  coverageAudit: {
    updatedAt: number | null;
    ageSec: number | null;
    maxAgeSec: number;
    status: YieldHealthFieldStatus;
    headlineGapCount: number | null;
    recommendationCandidateCount: number | null;
    manifestMissingCount: number | null;
    yieldBearingMissingFromRankingsCount: number | null;
    unmatchedHighTvlPoolCount: number | null;
    missingProtocolCount: number | null;
    nativeExactPoolRecommendationCount: number | null;
    sourceFamilyAdapterRecommendationCount: number | null;
    lendingAllowlistRecommendationCount: number | null;
    venueRiskConfigMissingCount: number | null;
    staleAutoLendingOverrideCount: number | null;
    staleVenueRiskScoreCount: number | null;
    headlineGaps: YieldCoverageAuditQueueItem[];
    recommendationCandidates: YieldCoverageAuditQueueItem[];
    allowedActions: YieldCoverageAuditQueueAction[];
    queuePersistence: "deferred";
  };
  sourceRiskCoverage: YieldSourceRiskCoverageSummary;
  comparisonAnchorFreshness: YieldComparisonAnchorFreshnessSummary;
  latestCronStatus: string | null;
  latestCronStartedAt: number | null;
}

export interface MintBurnReconciliationRow {
  stablecoinId: string;
  symbol: string;
  flowNet24hUsd: number;
  chainSupplyDelta24hUsd: number | null;
  absoluteDiffUsd: number | null;
  diffRatio: number | null;
  status: "ok" | "warn" | "critical" | "insufficient-source";
  coverageStatus: MintBurnCoverageStatus | "unknown";
}

export interface MintBurnReconciliationSummary {
  checkedAt: number;
  comparedCoins: number;
  criticalCount: number;
  warnCount: number;
  insufficientCount: number;
  rows: MintBurnReconciliationRow[];
}

export interface ReserveDriftEntry {
  coinId: string;
  liveCollateralScore: number;
  curatedCollateralScore: number;
  delta: number;
}

export interface ClassificationWarning {
  coinId: string;
  governance: string;
  centralizedCustodyPct: number;
  threshold: number;
}

export interface CoinGeckoPriceDiffRow {
  stablecoinId: string;
  symbol: string;
  name: string;
  geckoId: string;
  ourPrice: number;
  coinGeckoPrice: number;
  diffPct: number;
  priceSource: string;
  priceConfidence: string | null;
}

export interface CoinGeckoPriceDiff {
  checkedAt: number;
  trackedWithGeckoId: number;
  comparedCoins: number;
  mismatchedCount: number;
  thresholdPct: number;
  rows: CoinGeckoPriceDiffRow[];
}

export type PublicationSurfaceId =
  | "dex-liquidity"
  | "yield-rankings"
  | "stablecoins"
  | "dews"
  | "psi"
  | "report-card-cache";
export type PublicationGenerationState =
  | "candidate"
  | "validated"
  | "published"
  | "rejected"
  | "superseded"
  | "failed";

export interface PublicationGenerationHealth {
  generationId: string;
  sourceState: string;
  state: PublicationGenerationState;
  startedAt: number;
  validatedAt: number | null;
  publishedAt: number | null;
  failedAt: number | null;
  candidateRows: number | null;
  publishedRows: number | null;
  expectedRows: number | null;
  failureReason: string | null;
  metadata?: Record<string, unknown>;
}

export interface PublicationSurfaceHealth {
  surface: PublicationSurfaceId;
  label: string;
  sourceOfTruth: string;
  lastPublishedGeneration: PublicationGenerationHealth | null;
  lastAttemptedGeneration: PublicationGenerationHealth | null;
  lastFailureReason: string | null;
  candidateAgeSec: number | null;
  dependencyWatermarks: Record<string, unknown> | null;
}

export interface PublicationSurfaceFailure {
  surface: PublicationSurfaceId;
  code: string;
  message: string;
}

export interface PublicationHealth {
  checkedAt: number;
  surfaces: Partial<Record<PublicationSurfaceId, PublicationSurfaceHealth>>;
  failedSurfaces?: PublicationSurfaceFailure[];
}

export type DependencyHealthStatus = "healthy" | "degraded" | "stale" | "unknown";
export type DependencyImpactLayer = "availability" | "data-quality" | "system";
export type DependencyCriticality = "critical" | "watch";

export interface DependencyHealthItem {
  id: string;
  label: string;
  sourceOfTruth: string;
  producerJob: string | null;
  cacheKey: string | null;
  publicationSurface: PublicationSurfaceId | null;
  impactLayer: DependencyImpactLayer;
  criticality: DependencyCriticality;
  dependsOn: string[];
  consumers: string[];
  status: DependencyHealthStatus;
  checkedAt: number;
  updatedAt: number | null;
  ageSeconds: number | null;
  maxAgeSec: number | null;
  reason: string | null;
  runbookPath: string | null;
}

export interface DependencyRootCauseGroup {
  rootDependencyId: string;
  rootStatus: DependencyHealthStatus;
  rootReason: string | null;
  symptomDependencyIds: string[];
  impactedDependencyIds: string[];
  consumerIds: string[];
  criticality: DependencyCriticality;
}

export interface DependencyHealth {
  checkedAt: number;
  dependencies: Record<string, DependencyHealthItem>;
  rootCauseGroups: DependencyRootCauseGroup[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    stale: number;
    unknown: number;
    rootCauseGroupCount: number;
  };
}

export interface ProviderCircuitHealthEntry {
  providerId: string;
  family: string;
  state: CircuitRecord["state"];
  consecutiveFailures: number;
  openedAt: number | null;
  openAgeSec: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export interface ProviderCircuitHealthFamilySummary {
  total: number;
  closed: number;
  halfOpen: number;
  open: number;
}

export interface ProviderCircuitHealth {
  checkedAt: number;
  status: StatusHealthOrUnknown;
  totalTracked: number;
  closedCount: number;
  halfOpenCount: number;
  openCount: number;
  openProviders: ProviderCircuitHealthEntry[];
  byFamily: Record<string, ProviderCircuitHealthFamilySummary>;
}

export type CanaryRunStatus = "ok" | "degraded" | "error" | "skipped";
export type CanaryRunSeverity = "info" | "warning" | "error" | "critical";

export interface CanaryStatusCheck {
  checkId: string;
  label: string;
  description: string;
  status: CanaryRunStatus;
  severity: CanaryRunSeverity;
  observedAt: number;
  durationMs: number | null;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface CanaryStatus {
  checkedAt: number;
  status: StatusHealthOrUnknown;
  latestRunAt: number | null;
  maxAgeSec: number;
  totalChecks: number;
  okCount: number;
  degradedCount: number;
  errorCount: number;
  skippedCount: number;
  staleCount: number;
  checks: Record<string, CanaryStatusCheck>;
}

export interface D1UsageSummary {
  checkedAt: number;
  windowStart: number;
  windowEnd: number;
  databaseId: string;
  databaseName: string | null;
  databaseSizeBytes: number | null;
  numTables: number | null;
  region: string | null;
  readReplicationMode: string | null;
  readQueries24h: number | null;
  writeQueries24h: number | null;
  rowsRead24h: number | null;
  rowsWritten24h: number | null;
}

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

export const StatusResponseSchema: z.ZodType<StatusResponse> = z.object({
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
}).passthrough().transform((value): StatusResponse => ({
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

export const PublicStatusTransitionSchema: z.ZodType<PublicStatusTransition> = z.object({
  id: z.number(),
  from: StatusHealthValueSchema.nullable(),
  to: StatusHealthValueSchema,
  transitionType: z.enum(["degrade", "recover", "init"]),
  reason: z.string(),
  at: z.number(),
}).passthrough();

export const PublicStatusHistoryResponseSchema: z.ZodType<PublicStatusHistoryResponse> = z.object({
  timestamp: z.number(),
  currentStatus: StatusHealthValueSchema,
  lastChangedAt: z.number().nullable(),
  transitions: z.array(PublicStatusTransitionSchema),
}).passthrough();

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
    sync: {
      lastSuccessfulSyncAt: number | null;
      freshnessStatus: "fresh" | "degraded" | "stale";
      warning: string | null;
      criticalLaneHealthy: boolean;
    };
  };
  circuits: Record<string, CircuitRecord>;
  telegramSummary?: TelegramHealthSummary | null;
}

const TelegramHealthSummarySchema = z.object({
  totalChats: z.number(),
  pendingDeliveries: z.number(),
  lastDispatchAt: z.number().nullable(),
  lastDispatchStatus: z.string().nullable(),
  ...SafetyAlertFieldsNullableSchemaShape,
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
    sync: z.object({
      lastSuccessfulSyncAt: z.number().nullable(),
      freshnessStatus: z.enum(["fresh", "degraded", "stale"]),
      warning: z.string().nullable(),
      criticalLaneHealthy: z.boolean(),
    }),
  }),
  circuits: z.record(z.string(), CircuitRecordSchema),
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
