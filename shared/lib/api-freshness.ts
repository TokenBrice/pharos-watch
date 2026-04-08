import { CRON_INTERVALS } from "./cron-jobs";
import { DAY_SECONDS } from "./time-constants";

// Shared endpoint freshness budgets used by HTTP freshness headers and the UI
// warning layer. Keep these aligned with the worker handlers that emit
// X-Data-Age / Warning headers.
export const API_FRESHNESS_MAX_AGE_SEC = {
  stablecoins: 900,
  stablecoinCharts: 3600,
  chains: 900,
  pegSummary: 900,
  depegEvents: 900,
  stressSignals: 1800,
  reportCards: 900,
  redemptionBackstops: 3600,
  mintBurnFlows: CRON_INTERVALS["sync-mint-burn"] * 2,
  mintBurnEvents: 900,
  blacklist: CRON_INTERVALS["sync-blacklist"],
  blacklistSummary: CRON_INTERVALS["sync-blacklist"],
  dexLiquidity: 3600,
  yieldRankings: CRON_INTERVALS["sync-yield-data"],
  yieldHistory: CRON_INTERVALS["sync-yield-data"],
  stabilityIndex: DAY_SECONDS,
  dailyDigest: 7200,
  digestArchive: DAY_SECONDS,
  bluechip: 43200,
  usdsStatus: DAY_SECONDS,
  nonUsdShare: DAY_SECONDS,
} as const;
