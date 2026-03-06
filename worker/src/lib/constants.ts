import { SECONDS } from "./time-constants";

/** Minimum peg deviation (in basis points) to trigger a depeg event */
const DEPEG_THRESHOLD_BPS = 100;

/** Higher threshold for non-USD pegs — FX rate noise + thin liquidity cause more false positives */
const DEPEG_THRESHOLD_BPS_NON_USD = 150;

/** Returns the appropriate depeg threshold for a given peg type */
export function getDepegThresholdBps(pegType: string | undefined): number {
  return pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
}

/** Maximum age (in seconds) for a DEX price observation to be considered fresh */
export const DEX_FRESHNESS_SEC = 1200;

/**
 * UI-facing peg-summary DEX price check freshness window.
 * Dex liquidity sync runs every 30 minutes, so this allows one missed slot
 * before hiding the DEX cross-check column data.
 */
export const DEX_PRICE_CHECK_FRESHNESS_SEC = 3600;

/** D1 batch statement limit per db.batch() call */
export const D1_BATCH_SIZE = 100;

// --- External API base URLs ---

export const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

export const DEFILLAMA_BASE = "https://stablecoins.llama.fi";
export const DEFILLAMA_COINS = "https://coins.llama.fi";
export const DEFILLAMA_API = "https://api.llama.fi";

export const USER_AGENT = "Pharos/1.0 (stablecoin analytics)";

export const RUB_FALLBACK = 0.011;

/** Minimum number of assets expected from DefiLlama to consider sync valid */
export const MIN_VALID_ASSET_COUNT = 50;

/** DexScreener minimum liquidity threshold in USD for pool validation */
export const DEXSCREENER_MIN_LIQUIDITY_USD = 50_000;

/** Tron burn address (used to exclude from supply calculations) */
export const TRON_BURN_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

/** Standard Cache-Control header profiles for API responses */
export const CACHE_PROFILES = {
  /** ~realtime data: stablecoins, blacklist, depeg-events, peg-summary */
  realtime: "public, s-maxage=60, max-age=10",
  /** Standard refresh: stablecoin-charts, dex-liquidity, usds-status */
  standard: "public, s-maxage=300, max-age=60",
  /** Slow-changing data: dex-liquidity-history, supply-history, daily-digest, bluechip-ratings */
  slow: "public, s-maxage=3600, max-age=300",
} as const;

/** Maximum cache age (in seconds) per cache key — used by both /health and /status endpoints */
export const CACHE_FRESHNESS_THRESHOLDS: Record<string, number> = {
  stablecoins: 600,
  "stablecoin-charts": 600,
  "usds-status": SECONDS.ONE_DAY,
  "fx-rates": SECONDS.THIRTY_MINUTES,
  "bluechip-ratings": SECONDS.ONE_DAY,
  "dex-liquidity": SECONDS.TWELVE_HOURS,
  "yield-data": SECONDS.ONE_HOUR,
  dews: SECONDS.THIRTY_MINUTES,
};

// --- Depeg multi-source confirmation (>$1B coins) ---

/** Minimum circulating supply (USD) for multi-source depeg confirmation */
export const DEPEG_CONFIRMATION_SUPPLY_THRESHOLD = 1_000_000_000; // $1B

/** Minimum age (seconds) before a pending depeg can be promoted */
export const DEPEG_PENDING_MIN_AGE_SEC = 900; // 15 min (1 sync cycle)

/** Maximum age (seconds) before an unconfirmed pending depeg expires */
export const DEPEG_PENDING_EXPIRY_SEC = 2700; // 45 min (3 sync cycles)

/** Secondary source agreement threshold as fraction of primary threshold */
export const DEPEG_SECONDARY_THRESHOLD_RATIO = 0.5;

// --- Yield Intelligence ---

export const RISK_FREE_RATE_FALLBACK = 4.25;
/** FRED 3-month Treasury yield series (DGS3MO), used by fetch-tbill-rate cron. */
export const FRED_TBILL_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO";
export const FRED_FETCH_TIMEOUT_MS = 15_000;
export const FRED_FETCH_MAX_RETRIES = 1;
export const PYS_SCALING_FACTOR = 5;
/** Default safety score for unrated coins (navTokens, coins with insufficient data). */
export const DEFAULT_SAFETY_SCORE = 40;
/** Minimum report-card score for a coin to qualify for automatic yield discovery (C- = 50). */
export const MIN_SAFETY_SCORE_FOR_YIELD = 50;
/** Minimum APY (%) for auto-discovered lending pools to be eligible. */
export const MIN_LENDING_POOL_APY = 0.5;
/** Minimum TVL (USD) for auto-discovered lending pools to be eligible. */
export const MIN_LENDING_POOL_TVL_USD = 1_000_000;

// --- Circuit breaker source names ---

export const CIRCUIT_SOURCE = {
  DL_STABLECOINS: "defillama-stablecoins",
  DL_STABLECOIN_DETAIL: "defillama-stablecoin-detail",
  DL_COINS: "defillama-coins",
  DL_YIELDS: "defillama-yields",
  DL_PROTOCOLS: "defillama-protocols",
  CG_PRICES: "coingecko-prices",
  CG_DETAIL_PLATFORMS: "coingecko-detail-platforms",
  CG_MCAP: "coingecko-mcap",
  DEXSCREENER_PRICES: "dexscreener-prices",
  CMC_PRICES: "coinmarketcap-prices",
  TREASURY_RATES: "treasury-rates",
  ETHERSCAN: "etherscan",
  ALCHEMY: "alchemy",
  TWITTER_API: "twitter-api",
  TELEGRAM_API: "telegram-api",
} as const;
