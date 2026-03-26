import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

/** Shared cron interval constants in milliseconds, derived from shared cron job definitions. */
export const CRON_1MIN = 60_000;
export const CRON_15MIN = CRON_INTERVALS["sync-stablecoins"] * 1000;
export const CRON_20MIN = CRON_INTERVALS["sync-mint-burn"] * 1000;
export const CRON_BLACKLIST = CRON_INTERVALS["sync-blacklist"] * 1000;
export const CRON_30MIN = CRON_INTERVALS["sync-dex-liquidity"] * 1000;
export const CRON_YIELD = CRON_INTERVALS["sync-yield-data"] * 1000;
export const CRON_1H = CRON_INTERVALS["sync-live-reserves"] * 1000;
export const CRON_24H = CRON_INTERVALS["sync-bluechip"] * 1000;
