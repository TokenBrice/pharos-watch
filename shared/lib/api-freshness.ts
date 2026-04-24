import { CRON_INTERVALS } from "./cron-jobs";
import { DAY_SECONDS } from "./time-constants";

export interface CacheFreshnessLaneConfig {
  cacheKey: string;
  producerJob: string;
  producerIntervalSec: number;
  endpointMaxAgeSec: number;
  availabilityMaxAgeSec: number;
  endpointBudgetReason: string;
  availabilityBudgetReason: string;
  freshnessSentinelKey?: string;
}

export const CACHE_FRESHNESS_LANES = {
  stablecoins: {
    cacheKey: "stablecoins",
    producerJob: "sync-stablecoins",
    producerIntervalSec: CRON_INTERVALS["sync-stablecoins"],
    endpointMaxAgeSec: 600,
    availabilityMaxAgeSec: 600,
    endpointBudgetReason: "Stricter public freshness budget for the core market snapshot.",
    availabilityBudgetReason: "Matches the core market endpoint budget used by public health.",
  },
  stablecoinCharts: {
    cacheKey: "stablecoin-charts",
    producerJob: "sync-stablecoin-charts",
    producerIntervalSec: CRON_INTERVALS["sync-stablecoin-charts"],
    endpointMaxAgeSec: 3600,
    availabilityMaxAgeSec: 3600,
    endpointBudgetReason: "Chart writes are cooldown-gated to at most once per hour.",
    availabilityBudgetReason: "Matches the hourly chart write cooldown.",
  },
  usdsStatus: {
    cacheKey: "usds-status",
    producerJob: "sync-usds-status",
    producerIntervalSec: CRON_INTERVALS["sync-usds-status"],
    endpointMaxAgeSec: DAY_SECONDS,
    availabilityMaxAgeSec: DAY_SECONDS,
    endpointBudgetReason: "USDS protocol status is refreshed daily.",
    availabilityBudgetReason: "Matches the daily USDS status writer cadence.",
  },
  fxRates: {
    cacheKey: "fx-rates",
    producerJob: "sync-fx-rates",
    producerIntervalSec: CRON_INTERVALS["sync-fx-rates"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-fx-rates"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-fx-rates"],
    endpointBudgetReason: "FX writes are internally cooldown-gated to 30 minutes.",
    availabilityBudgetReason: "Matches the 30-minute usable FX publication cadence.",
  },
  bluechipRatings: {
    cacheKey: "bluechip-ratings",
    producerJob: "sync-bluechip",
    producerIntervalSec: CRON_INTERVALS["sync-bluechip"],
    endpointMaxAgeSec: 12 * 3600,
    availabilityMaxAgeSec: DAY_SECONDS,
    endpointBudgetReason: "Public Bluechip reads use a stricter advisory budget than the daily writer.",
    availabilityBudgetReason: "Availability follows the daily Bluechip producer cadence.",
  },
  dexLiquidity: {
    cacheKey: "dex-liquidity",
    producerJob: "sync-dex-liquidity",
    producerIntervalSec: CRON_INTERVALS["sync-dex-liquidity"],
    endpointMaxAgeSec: 3600,
    availabilityMaxAgeSec: 12 * 3600,
    endpointBudgetReason: "DEX liquidity endpoints warn after a missed scoring runway.",
    availabilityBudgetReason: "Public health keeps a slower availability runway for the last successful liquidity dataset.",
    freshnessSentinelKey: "freshness:dex-liquidity",
  },
  yieldData: {
    cacheKey: "yield-data",
    producerJob: "sync-yield-data",
    producerIntervalSec: CRON_INTERVALS["sync-yield-data"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    endpointBudgetReason: "Yield publication runs hourly.",
    availabilityBudgetReason: "Matches the hourly yield publication cadence.",
    freshnessSentinelKey: "freshness:yield-data",
  },
  dews: {
    cacheKey: "dews",
    producerJob: "compute-dews",
    producerIntervalSec: CRON_INTERVALS["compute-dews"],
    endpointMaxAgeSec: CRON_INTERVALS["compute-dews"],
    availabilityMaxAgeSec: CRON_INTERVALS["compute-dews"],
    endpointBudgetReason: "DEWS compute runs every 30 minutes.",
    availabilityBudgetReason: "Matches the 30-minute DEWS compute cadence.",
    freshnessSentinelKey: "freshness:dews",
  },
} as const satisfies Record<string, CacheFreshnessLaneConfig>;

export type CacheFreshnessLaneKey = keyof typeof CACHE_FRESHNESS_LANES;

const CACHE_FRESHNESS_LANES_BY_CACHE_KEY = Object.freeze(
  Object.fromEntries(
    Object.values(CACHE_FRESHNESS_LANES).map((lane) => [lane.cacheKey, lane]),
  ) as Record<string, CacheFreshnessLaneConfig>,
);

export const CACHE_AVAILABILITY_MAX_AGE_SEC = Object.freeze(
  Object.fromEntries(
    Object.values(CACHE_FRESHNESS_LANES).map((lane) => [lane.cacheKey, lane.availabilityMaxAgeSec]),
  ) as Record<string, number>,
);

export const FRESHNESS_SENTINEL_CACHE_KEYS = [
  "dex-liquidity",
  "yield-data",
  "dews",
] as const;

export function getCacheFreshnessLane(cacheKey: string): CacheFreshnessLaneConfig | null {
  return CACHE_FRESHNESS_LANES_BY_CACHE_KEY[cacheKey] ?? null;
}

// Shared endpoint freshness budgets used by HTTP freshness headers and the UI
// warning layer. Keep these aligned with the worker handlers that emit
// X-Data-Age / Warning headers.
export const API_FRESHNESS_MAX_AGE_SEC = {
  stablecoins: CACHE_FRESHNESS_LANES.stablecoins.endpointMaxAgeSec,
  stablecoinCharts: CACHE_FRESHNESS_LANES.stablecoinCharts.endpointMaxAgeSec,
  chains: 1800,
  pegSummary: 900,
  depegEvents: 900,
  stressSignals: CACHE_FRESHNESS_LANES.dews.endpointMaxAgeSec,
  reportCards: 900,
  redemptionBackstops: CRON_INTERVALS["sync-redemption-backstops"] * 2,
  supplyHistory: DAY_SECONDS,
  mintBurnFlows: CRON_INTERVALS["sync-mint-burn"] * 2,
  mintBurnEvents: 900,
  blacklist: CRON_INTERVALS["sync-blacklist"],
  blacklistSummary: CRON_INTERVALS["sync-blacklist"],
  dexLiquidity: CACHE_FRESHNESS_LANES.dexLiquidity.endpointMaxAgeSec,
  yieldRankings: CACHE_FRESHNESS_LANES.yieldData.endpointMaxAgeSec,
  yieldHistory: CACHE_FRESHNESS_LANES.yieldData.endpointMaxAgeSec,
  stabilityIndex: DAY_SECONDS,
  dailyDigest: 7200,
  digestArchive: DAY_SECONDS,
  bluechip: CACHE_FRESHNESS_LANES.bluechipRatings.endpointMaxAgeSec,
  usdsStatus: CACHE_FRESHNESS_LANES.usdsStatus.endpointMaxAgeSec,
  nonUsdShare: DAY_SECONDS,
} as const;
