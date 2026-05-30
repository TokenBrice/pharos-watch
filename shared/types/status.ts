import { z } from "zod";
import type { LiquidityCoverageClass } from "./market";
import type { MintBurnCoverageStatus } from "./mint-burn";
import type { DiscoveryCandidate } from "./discovery";
import type { PriceSourceHealth } from "./pricing-source-health";

export type { DiscoveryCandidate, DiscoveryCandidatesResponse } from "./discovery";
export type {
  PriceSourceDepthBucket,
  PriceSourceDepthDistribution,
  PriceSourceHealth,
  PriceSourceHealthBucketKey,
} from "./pricing-source-health";

export interface CacheStatus {
  ageSeconds: number | null;
  /** Availability budget used by /api/health and /api/status ratio bands. */
  maxAge: number;
  healthy: boolean;
  freshnessSource?: "freshness-sentinel" | "table-fallback" | "cron-fallback";
  sentinelValidationReason?: string | null;
  producerJob?: string | null;
  producerIntervalSec?: number | null;
  endpointMaxAge?: number | null;
  availabilityMaxAge?: number | null;
  endpointBudgetReason?: string | null;
  availabilityBudgetReason?: string | null;
  mode?: "live" | "cached-fallback";
  sourceUpdatedAt?: number | null;
  sourceAgeSeconds?: number | null;
  sourceStatus?: "fresh" | "degraded" | "stale" | "none";
  warning?: string | null;
  consecutiveFallbackRuns?: number;
  /** Human-friendly upstream provider (Binance, CoinGecko, DefiLlama, on-chain RPC, …). */
  upstreamProvider?: string | null;
}

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

export interface CronRun {
  startedAt: number;
  durationMs: number;
  status: string;
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

export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
  telemetryUnknown?: boolean;
  inFlight?: CronInFlight | null;
  /**
   * Set to `true` only for watch-tier crons that have zero historical runs
   * (bootstrap state). The cron is considered healthy in this state because
   * its first successful run has not yet produced a `cron_runs` row, so
   * there is no history to compare against. Critical-tier crons do not get
   * this flag — they are unhealthy until they have produced at least one run.
   */
  bootstrap?: boolean;
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
  currentStatus: "healthy" | "degraded" | "stale";
  rawStatus: "healthy" | "degraded" | "stale";
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
  status: "healthy" | "degraded" | "stale" | "unknown";
  sampleCount: number;
  passCount: number;
  failCount: number;
  bootstrapMissCount?: number;
  p95LatencyMs: number | null;
}

export type StatusDiscrepancyReason = "in-sync" | "probe-stale" | "probe-disagrees" | "probe-missing";

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
  from: "healthy" | "degraded" | "stale" | null;
  to: "healthy" | "degraded" | "stale";
  rawStatus: "healthy" | "degraded" | "stale";
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

export interface TelegramAlertTypeChats {
  dews: number;
  depeg: number;
  safety: number;
  launch: number;
  allTypes: number;
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

export interface TelegramTelemetryQuality {
  status: "complete" | "partial";
  unavailableFields: string[];
  /** Exact diagnostic strings are for Access-gated operator surfaces only. */
  errors?: Record<string, string>;
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

/** Slim public-facing stats for the PharosWatchBot landing page. */
export interface TelegramWatcherHistoryPoint {
  /** YYYY-MM-DD UTC day bucket. Snapshot-backed once lifecycle rows exist. */
  date: string;
  /** UTC day timestamp in milliseconds, for frontend time-axis charts. */
  timestamp: number;
  /** UTC snapshot timestamp in seconds for snapshot-backed rows. */
  snapshotAt?: number | null;
  /** New active watchers captured in this daily bucket; null when suppressed for low-cardinality privacy. */
  newWatchers?: number | null;
  /** Active watcher count at the daily snapshot, or cumulative fallback for pre-snapshot data. */
  activeWatchers: number;
  /** Aggregate churn estimate for snapshot-backed points; null when suppressed for low-cardinality privacy. */
  churnedWatchers?: number | null;
  /** Aggregate reactivation estimate for snapshot-backed points; null when suppressed for low-cardinality privacy. */
  reactivatedWatchers?: number | null;
}

export interface TelegramPulsePrivacy {
  exactActiveWatchers: boolean;
  lowCardinalityThreshold: number;
  suppressedFields: string[];
}

export interface TelegramPulse {
  activeWatchers: number;
  coinSubscriptions: number;
  explicitCoinSubscriptions?: number;
  presetImpliedCoinSubscriptions?: number;
  activePresetFollowers?: number;
  newWatchersToday?: number | null;
  churnedWatchersToday?: number | null;
  reactivatedWatchersToday?: number | null;
  historySource?: "snapshot" | "live-fallback";
  topCoins: string[];
  watcherHistory: TelegramWatcherHistoryPoint[];
  alertTypeChats: TelegramAlertTypeChats;
  quietHoursEnabledChats: number | null;
  pendingDeliveries: number | null;
  miniAppSessionsToday?: number | null;
  miniAppMutationsToday?: number | null;
  miniAppDeniedToday?: number | null;
  miniAppReplayClaimsToday?: number | null;
  miniAppOpenToFirstMutationP50Sec?: number | null;
  currentSnapshotAt: number;
  lifecycleHistoryUpdatedAt: number | null;
  lifecycleHistoryEverySeconds: number;
  quality: TelegramTelemetryQuality;
  privacy: TelegramPulsePrivacy;
  updatedAt: number;
  updatedEverySeconds: number;
}

const TelegramAlertTypeChatsSchema: z.ZodType<TelegramAlertTypeChats> = z.object({
  dews: z.number(),
  depeg: z.number(),
  safety: z.number(),
  launch: z.number(),
  allTypes: z.number(),
});

const TelegramTelemetryQualitySchema: z.ZodType<TelegramTelemetryQuality> = z.object({
  status: z.enum(["complete", "partial"]),
  unavailableFields: z.array(z.string()),
  errors: z.record(z.string(), z.string()).optional(),
});

const TelegramPulsePrivacySchema: z.ZodType<TelegramPulsePrivacy> = z.object({
  exactActiveWatchers: z.boolean(),
  lowCardinalityThreshold: z.number(),
  suppressedFields: z.array(z.string()),
});

const TelegramWatcherHistoryPointSchema: z.ZodType<TelegramWatcherHistoryPoint> = z.object({
  date: z.string(),
  timestamp: z.number(),
  snapshotAt: z.number().nullable().optional(),
  newWatchers: z.number().nullable().optional(),
  activeWatchers: z.number(),
  churnedWatchers: z.number().nullable().optional(),
  reactivatedWatchers: z.number().nullable().optional(),
});

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
  alertTypeChats: TelegramAlertTypeChatsSchema,
  quietHoursEnabledChats: z.number().nullable(),
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

export const TelegramPulseSchema: z.ZodType<TelegramPulse> = TelegramPulseBaseSchema.transform((pulse) => ({
  ...pulse,
  currentSnapshotAt: pulse.currentSnapshotAt ?? pulse.updatedAt,
  lifecycleHistoryUpdatedAt: pulse.lifecycleHistoryUpdatedAt ?? null,
  lifecycleHistoryEverySeconds: pulse.lifecycleHistoryEverySeconds ?? 900,
  quality: pulse.quality ?? { status: "complete", unavailableFields: [] },
  privacy: pulse.privacy ?? {
    exactActiveWatchers: true,
    lowCardinalityThreshold: 5,
    suppressedFields: [],
  },
}));

export interface TelegramDispatchEventsDetected {
  dews: number;
  depeg: number;
  depegTriggered: number;
  depegResolved: number;
  depegWorsening: number;
  safety: number;
  launch: number;
  suppressedMethodologyChanges: number;
}

/** The four alert categories tracked by the Telegram dispatcher. */
export type TelegramAlertType = "dews" | "depeg" | "safety" | "launch";

export interface PerAlertTypeDeliveryStats {
  sent: number;
  enqueued: number;
  failed: number;
  blocked: number;
  firstSendLatencyMs: number | null;
}

export type PerAlertTypeDelivery = Record<TelegramAlertType, PerAlertTypeDeliveryStats>;

export type SafetyAlertSourceState = "ok" | "missing" | "corrupt" | "stale" | "wrong-generation";

export interface TelegramDispatchCronResult {
  subscribersNotified: number;
  messagesSent: number;
  blockedUsersCleanedUp: number;
  blockedUsersCleanupFailed: number;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
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

export interface ParsedTelegramDispatchEventsDetected {
  dews: number | null;
  depeg: number | null;
  depegTriggered: number | null;
  depegResolved: number | null;
  depegWorsening: number | null;
  safety: number | null;
  launch: number | null;
  suppressedMethodologyChanges: number | null;
}

export interface TelegramDispatchCronMetadata {
  subscribersNotified: number | null;
  messagesSent: number | null;
  blockedUsersCleanedUp: number | null;
  blockedUsersCleanupFailed: number | null;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
  skipped: string | null;
  freshAttempted: number | null;
  freshSent: number | null;
  freshRetryQueued: number | null;
  freshPermanentFailures: number | null;
  freshDeferredPerChat: number | null;
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
  safetyAlertSourceState: SafetyAlertSourceState | null;
  safetyAlertSourceAgeSeconds: number | null;
  safetyAlertsSuppressed: boolean;
  safetyAlertSourceGeneration: string | null;
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
  failedSources: string[];
  nearCoverageGuard: boolean;
  nearValueGuard: boolean;
  nearMajorCoverageGuard: boolean;
  currentCoverageClasses: Record<LiquidityCoverageClass, number>;
  previousCoverageClasses: Record<LiquidityCoverageClass, number>;
}

export type YieldHealthFieldStatus = "healthy" | "degraded" | "stale" | "unknown";

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

export type YieldCoverageAuditQueueAction = "accept" | "dismiss" | "intentional-gap" | "watch";

export type YieldCoverageAuditQueueItemKind =
  | "manifest-missing"
  | "ranking-missing"
  | "unmatched-high-tvl-pool"
  | "missing-protocol"
  | "native-exact-pool"
  | "source-family-adapter"
  | "lending-allowlist";

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
    headlineGaps: YieldCoverageAuditQueueItem[];
    recommendationCandidates: YieldCoverageAuditQueueItem[];
    allowedActions: YieldCoverageAuditQueueAction[];
    queuePersistence: "deferred";
  };
  sourceRiskCoverage: YieldSourceRiskCoverageSummary;
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
  | "telegramBot"
  | "reserveComposition"
  | "d1Usage"
  | "liquidityHealth"
  | "yieldHealth"
  | "priceSourceHealth"
  | "coingeckoPriceDiff"
  | "discoveryCandidates"
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
  availabilityStatus: "healthy" | "degraded" | "stale";
  dataQualityStatus: "healthy" | "degraded" | "stale";
  rawOverallStatus: "healthy" | "degraded" | "stale";
  overallStatus: "healthy" | "degraded" | "stale";
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
  reserveComposition: {
    configuredCoins: number;
    freshCoins: number;
    staleCoins: number;
    missingCoins: number;
    degradedCoins: number;
    errorCoins: number;
    corruptCoins: number;
    independentFreshEligible: number;
    independentFreshUnverified: number;
    staticValidatedFresh: number;
    weakProbeFresh: number;
    writeTimeoutUncertain: number;
    deferredCoins: number;
    runBudgetTruncated: boolean;
    deferredAt: number | null;
    nextCursorStablecoinId: string | null;
    /**
     * Coins whose adapter is classified as independent evidence but whose
     * latest source has been stuck in degraded/error with the last
     * successful snapshot older than 14 days. Sorted by age descending.
     */
    persistentlyStaleIndependentCoins: Array<{ stablecoinId: string; ageSec: number }>;
    lastSuccessAt: number | null;
    oldestFreshAgeSec: number | null;
    status: "healthy" | "degraded" | "stale";
    freshCoverageRatio: number;
    authoritativeFreshCoverageRatio: number;
  };
  cacheBlobSizes?: Record<string, number>;
  reserveDrift?: ReserveDriftEntry[];
  classificationWarnings?: ClassificationWarning[];
}

export interface StatusHistoryResponse {
  timestamp: number;
  state: StatusStateInfo | null;
  staleness: StatusStaleness | null;
  probe: StatusProbeSummary;
  discrepancy: StatusDiscrepancy;
  transitions: StatusTransition[];
  reserveComposition: StatusResponse["reserveComposition"] | null;
}

const StatusHealthValueSchema = z.enum(["healthy", "degraded", "stale"]);
const StatusJsonObjectSchema = z.object({}).passthrough();

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

const StatusProbeSummarySchema = z.object({
  timestamp: z.number().nullable(),
  status: z.enum(["healthy", "degraded", "stale", "unknown"]),
  sampleCount: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  bootstrapMissCount: z.number().optional(),
  p95LatencyMs: z.number().nullable(),
});

const StatusDiscrepancySchema = z.object({
  hasDivergence: z.boolean(),
  severityDelta: z.number(),
  statusSeverity: z.number(),
  probeSeverity: z.number(),
  details: z.string().nullable(),
  probeAgeSeconds: z.number().nullable(),
  consecutiveDivergent: z.number(),
  discrepancyReason: z.enum(["in-sync", "probe-stale", "probe-disagrees", "probe-missing"]),
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
  crons: z.record(z.string(), StatusJsonObjectSchema),
  dataQuality: StatusJsonObjectSchema,
  telegramBot: StatusJsonObjectSchema.nullable(),
  sectionErrors: z.record(z.string(), z.object({ code: z.string(), message: z.string() })),
  datasetFreshness: StatusJsonObjectSchema,
  summary: StatusJsonObjectSchema,
  liquidityHealth: StatusJsonObjectSchema.nullable(),
  yieldHealth: StatusJsonObjectSchema.nullable(),
  priceSourceHealth: StatusJsonObjectSchema.nullable(),
  priceProviderDiagnostics: z.array(StatusJsonObjectSchema).nullable(),
  gtProbe: StatusJsonObjectSchema.nullable(),
  coingeckoPriceDiff: StatusJsonObjectSchema.nullable(),
  d1Usage: StatusJsonObjectSchema.nullable(),
  discoveryCandidates: z.array(StatusJsonObjectSchema).nullable(),
  mintBurnReconciliation: StatusJsonObjectSchema.nullable(),
  reserveComposition: StatusJsonObjectSchema,
  cacheBlobSizes: z.record(z.string(), z.number()).optional(),
  reserveDrift: z.array(StatusJsonObjectSchema).optional(),
  classificationWarnings: z.array(StatusJsonObjectSchema).optional(),
}).passthrough().transform((value): StatusResponse => value as unknown as StatusResponse);

export const StatusHistoryResponseSchema: z.ZodType<StatusHistoryResponse> = z.object({
  timestamp: z.number(),
  state: StatusStateInfoSchema.nullable(),
  staleness: StatusStalenessSchema.nullable(),
  probe: StatusProbeSummarySchema,
  discrepancy: StatusDiscrepancySchema,
  transitions: z.array(StatusTransitionSchema),
  reserveComposition: StatusJsonObjectSchema.nullable(),
}).transform((value): StatusHistoryResponse => value as unknown as StatusHistoryResponse);

export interface PublicStatusTransition {
  id: number;
  from: string | null;
  to: string;
  transitionType: "degrade" | "recover" | "init";
  reason: string;
  at: number;
}

export const PUBLIC_STATUS_HISTORY_WINDOWS = ["24h", "7d", "30d"] as const;

export type PublicStatusHistoryWindow = (typeof PUBLIC_STATUS_HISTORY_WINDOWS)[number];

export interface PublicStatusHistoryResponse {
  timestamp: number;
  currentStatus: "healthy" | "degraded" | "stale";
  lastChangedAt: number | null;
  transitions: PublicStatusTransition[];
}

export interface CircuitRecord {
  state: "closed" | "half-open" | "open";
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

const CircuitRecordSchema = z.object({
  state: z.enum(["closed", "half-open", "open"]),
  consecutiveFailures: z.number(),
  lastFailureAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  openedAt: z.number().nullable(),
});

export interface TelegramHealthSummary {
  totalChats: number;
  pendingDeliveries: number;
  lastDispatchAt: number | null;
  lastDispatchStatus: string | null;
  safetyAlertSourceState: SafetyAlertSourceState | null;
  safetyAlertSourceAgeSeconds: number | null;
  safetyAlertsSuppressed: boolean;
  safetyAlertSourceGeneration: string | null;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
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

export const HealthResponseSchema: z.ZodType<HealthResponse> = z.object({
  status: z.enum(["healthy", "degraded", "stale"]),
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
  telegramSummary: z.object({
    totalChats: z.number(),
    pendingDeliveries: z.number(),
    lastDispatchAt: z.number().nullable(),
    lastDispatchStatus: z.string().nullable(),
    safetyAlertSourceState: z.enum(["ok", "missing", "corrupt", "stale", "wrong-generation"]).nullable(),
    safetyAlertSourceAgeSeconds: z.number().nullable(),
    safetyAlertsSuppressed: z.boolean(),
    safetyAlertSourceGeneration: z.string().nullable(),
  }).nullable().optional(),
});

export interface EndpointProbeResult {
  path: string;
  status: number | null;
  latencyMs: number;
  error?: string;
  semanticStatus?: "healthy" | "degraded" | "stale";
  semanticDetail?: string | null;
  semanticScope?: "health" | "status" | "freshness";
}
