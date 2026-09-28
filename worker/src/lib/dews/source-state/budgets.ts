/**
 * DEWS input freshness budgets kept in a dependency-free module so lightweight
 * consumers (Telegram alert context) can reuse them without importing the
 * hydration loaders' module graph.
 */
export const DEWS_STALE_DEX_LIQUIDITY_SEC = 2 * 3600;
