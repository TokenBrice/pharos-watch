import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

/**
 * DEWS input freshness budgets kept in a lightweight module so consumers
 * (Telegram alert context) can reuse them without importing hydration loaders.
 */
export const DEWS_STALE_DEX_LIQUIDITY_SEC = 2 * 3600;
export const DEWS_PSI_FRESHNESS_BUDGET_SEC = API_FRESHNESS_MAX_AGE_SEC.stabilityIndex;
/**
 * Last-good yield-rankings retention: three yield producer intervals, the same
 * k × interval grace the status rules use for a delayed yield surface. A late
 * yield run within it keeps DEWS publishing with the retained generation named
 * in run metadata; beyond it the cohort dependency is unavailable.
 */
const DEWS_YIELD_RANKINGS_RETENTION_CADENCES = 3;
export const DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC =
  DEWS_YIELD_RANKINGS_RETENTION_CADENCES * CRON_INTERVALS["sync-yield-data"];
