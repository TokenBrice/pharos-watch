import { z } from "zod";
import type { LiquidityCoverageClass } from "./market";
import type { MintBurnCoverageStatus } from "./mint-burn";

export interface CacheStatus {
  ageSeconds: number | null;
  maxAge: number;
  healthy: boolean;
  mode?: "live" | "cached-fallback";
  sourceUpdatedAt?: number | null;
  sourceAgeSeconds?: number | null;
  sourceStatus?: "fresh" | "degraded" | "stale" | "none";
  warning?: string | null;
  consecutiveFallbackRuns?: number;
}

const CacheStatusSchema = z.object({
  ageSeconds: z.number().nullable(),
  maxAge: z.number(),
  healthy: z.boolean(),
  mode: z.enum(["live", "cached-fallback"]).optional(),
  sourceUpdatedAt: z.number().nullable().optional(),
  sourceAgeSeconds: z.number().nullable().optional(),
  sourceStatus: z.enum(["fresh", "degraded", "stale", "none"]).optional(),
  warning: z.string().nullable().optional(),
  consecutiveFallbackRuns: z.number().optional(),
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
  inFlight?: CronInFlight | null;
}

export interface StatusCause {
  code: string;
  layer: "availability" | "data-quality" | "system";
  severity: "info" | "warning" | "critical";
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
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

export interface StatusDiscrepancy {
  hasDivergence: boolean;
  severityDelta: number;
  statusSeverity: number;
  probeSeverity: number;
  details: string | null;
  probeAgeSeconds: number | null;
  consecutiveDivergent: number;
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
}

export interface TelegramBotStats {
  totalChats: number;
  alertEnabledChats: number;
  deliverableChats: number;
  subscribedChats: number;
  emptyAlertChats: number;
  mutedChatsWithSubscriptions: number;
  totalSubscriptions: number;
  avgSubscriptionsPerSubscribedChat: number;
  pendingDisambiguations: number;
  pendingDeliveries: number;
  lastSubscriberActivityAt: number | null;
  customPreferenceChats: number;
  quietHoursEnabledChats: number;
  alertTypeChats: {
    dews: number;
    depeg: number;
    safety: number;
    allTypes: number;
  };
  topStablecoins: TelegramBotTopStablecoin[];
}

export interface DiscoveryCandidate {
  id: number;
  geckoId: string | null;
  llamaId: number | null;
  name: string;
  symbol: string;
  marketCap: number | null;
  source: "defillama" | "coingecko" | "both";
  firstSeen: number;
  lastSeen: number;
  daysSeen: number;
  dismissed: boolean;
}

export interface DiscoveryCandidatesResponse {
  candidates: DiscoveryCandidate[];
  total: number;
}

export interface PriceSourceHealth {
  sourceDistribution: {
    coingecko: number;
    "coingecko+defillama-list": number;
    defillama: number;
    "defillama-list": number;
    "protocol-redeem": number;
    "defillama-contract": number;
    coinmarketcap: number;
    dexscreener: number;
    jupiter: number;
    pyth: number;
    binance: number;
    kraken: number;
    bitstamp: number;
    coinbase: number;
    redstone: number;
    "curve-onchain": number;
    "dex-promoted": number;
    geckoterminal: number;
    "pool-tvl-weighted": number;
    cached: number;
    missing: number;
  };
  confidenceDistribution: {
    high: number;
    "single-source": number;
    low: number;
    fallback: number;
  };
  totalAssets: number;
  lastSync: number;
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
  datasetFreshness: DatasetFreshness;
  summary: {
    unhealthyCrons: number;
    degradedCrons: number;
    cronErrors: number;
    worstCacheRatio: number;
  };
  liquidityHealth: LiquidityHealth | null;
  priceSourceHealth: PriceSourceHealth | null;
  discoveryCandidates: DiscoveryCandidate[] | null;
  mintBurnReconciliation: MintBurnReconciliationSummary | null;
  reserveComposition: {
    configuredCoins: number;
    freshCoins: number;
    staleCoins: number;
    missingCoins: number;
    degradedCoins: number;
    errorCoins: number;
    lastSuccessAt: number | null;
    oldestFreshAgeSec: number | null;
  };
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
    totalEvents: number;
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
    totalEvents: z.number(),
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
});

export interface EndpointProbeResult {
  path: string;
  status: number | null;
  latencyMs: number;
  error?: string;
  semanticStatus?: "healthy" | "degraded" | "stale";
  semanticDetail?: string | null;
  semanticScope?: "health" | "status";
}
