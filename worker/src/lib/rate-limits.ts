/** Centralized rate-limit and crawl-budget constants for all external APIs */

export const RATE_LIMITS = {
  /** CoinGecko onchain API: ~240 req/min paid plan, conservative with headroom */
  COINGECKO_ONCHAIN_MS: 250,
  /** CoinGecko backfill: 500 req/min budget → 200ms between calls */
  COINGECKO_BACKFILL_MS: 200,
  /** DexScreener: ~60 req/min free tier */
  DEXSCREENER_MS: 1100,
  /** GeckoTerminal: 30 req/min = 1 every 2s */
  GECKO_TERMINAL_MS: 2000,
} as const;

export const CRAWL_BUDGETS = {
  /** Max wall time for GT pool crawl (15 min within 30-min cron window) */
  GECKO_TERMINAL_MS: 15 * 60 * 1000,
} as const;
