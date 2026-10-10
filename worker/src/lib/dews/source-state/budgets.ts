import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

/**
 * DEWS input freshness budgets kept in a lightweight module so consumers
 * (Telegram alert context) can reuse them without importing hydration loaders.
 */
export const DEWS_STALE_DEX_LIQUIDITY_SEC = 2 * 3600;
export const DEWS_PSI_FRESHNESS_BUDGET_SEC = API_FRESHNESS_MAX_AGE_SEC.stabilityIndex;
