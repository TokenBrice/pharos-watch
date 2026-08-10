import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

/**
 * Shared cron interval constants in milliseconds. Constants named after a time
 * unit (`CRON_1MIN`, `CRON_1H`, `CRON_24H`) are hardcoded and safe to use as
 * generic polling budgets. Constants named after a cron job are derived from
 * `CRON_INTERVALS` in shared/lib/cron-jobs.ts so the frontend polling timing
 * tracks backend cron cadence per the CLAUDE.md rule (`staleTime = cron
 * interval`, `refetchInterval = 2× cron interval`).
 */
export const CRON_1MIN = 60_000;
export const CRON_1H = 60 * 60 * 1000;
export const CRON_24H = 24 * 60 * 60 * 1000;

export const CRON_15MIN = CRON_INTERVALS["sync-stablecoins"] * 1000;
export const CRON_30MIN = 30 * 60 * 1000;
export const CRON_BLACKLIST = CRON_INTERVALS["sync-blacklist"] * 1000;
export const CRON_MINT_BURN = CRON_INTERVALS["sync-mint-burn"] * 1000;
export const CRON_RESERVE_SYNC = CRON_INTERVALS["sync-live-reserves"] * 1000;
export const CRON_TELEGRAM_PULSE = CRON_INTERVALS["telegram-pulse-snapshot"] * 1000;
export const CRON_BLUECHIP = CRON_INTERVALS["sync-bluechip"] * 1000;
export const CRON_DAILY_DIGEST = CRON_INTERVALS["daily-digest"] * 1000;
export const CRON_SUPPLY_SNAPSHOT = CRON_INTERVALS["snapshot-supply"] * 1000;
export const CRON_SAFETY_GRADE_HISTORY = CRON_INTERVALS["snapshot-safety-grade-history"] * 1000;
export const CRON_CHARTS = CRON_INTERVALS["sync-stablecoin-charts"] * 1000;
export const CRON_USDS_STATUS = CRON_INTERVALS["sync-usds-status"] * 1000;
