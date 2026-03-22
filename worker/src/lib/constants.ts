import { SECONDS } from "./time-constants";

// 100bps (1%) minimum deviation to consider a depeg event for USD-pegged stablecoins.
// Below this, price movement is within normal market noise (bid-ask spreads,
// CEX-DEX arb latency). Calibrated against 2023-2024 false-positive rate.
const DEPEG_THRESHOLD_BPS = 100;

// 150bps for non-USD pegs (FX, commodity). Higher threshold because FX pairs
// have wider bid-ask spreads, commodity oracles update less frequently,
// and cross-currency pricing adds noise from FX rate staleness.
const DEPEG_THRESHOLD_BPS_NON_USD = 150;

/** Returns the appropriate depeg threshold for a given peg type */
export function getDepegThresholdBps(pegType: string | undefined): number {
  return pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
}

/** Maximum age (in seconds) for a DEX price observation to be considered fresh.
 *  Set to 35 min to cover the full 30-min scoring cron cycle + 5 min buffer (M-1). */
export const DEX_FRESHNESS_SEC = 2100;

/** Minimum per-pool liquidity required for a DEX price observation to be stored. */
export const DEX_PRICE_OBSERVATION_MIN_TVL_USD = 50_000;

/**
 * UI-facing peg-summary DEX price check freshness window.
 * Dex liquidity sync runs every 30 minutes, so this allows one missed slot
 * before hiding the DEX cross-check column data.
 */
export const DEX_PRICE_CHECK_FRESHNESS_SEC = 3600;

/** Minimum aggregate DEX source TVL required before showing a UI-facing DEX price check. */
export const DEX_PRICE_CHECK_UI_MIN_TVL_USD = 250_000;

/** Minimum aggregate DEX source TVL required before depeg logic trusts a DEX price row. */
export const DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD = 1_000_000;

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
  "stablecoin-charts": 3600,
  "usds-status": SECONDS.ONE_DAY,
  "fx-rates": SECONDS.THIRTY_MINUTES,
  "bluechip-ratings": SECONDS.ONE_DAY,
  "dex-liquidity": SECONDS.TWELVE_HOURS,
  "yield-data": SECONDS.ONE_HOUR,
  dews: SECONDS.THIRTY_MINUTES,
};

// --- Depeg multi-source confirmation (>$1B coins) ---

// Coins above $1B circulating supply require confirmation from a second price source
// (DEX or next sync cycle) before a depeg event is created. Below $1B, single-source
// detection is acceptable because false alerts have lower blast radius.
// $1B threshold covers ~top-10 stablecoins where false positives are most damaging.
export const DEPEG_CONFIRMATION_SUPPLY_THRESHOLD = 1_000_000_000; // $1B

/** Maximum age for a primary price to be trusted directly in depeg detection. */
export const DEPEG_PRIMARY_PRICE_MAX_AGE_SEC = 1800; // 30 min

/** Extreme-move lane: very large deviations must be second-source confirmed. */
export const DEPEG_EXTREME_MOVE_BPS = 5000; // 50%

/** Minimum age (seconds) before a pending depeg can be promoted */
export const DEPEG_PENDING_MIN_AGE_SEC = 900; // 15 min (1 sync cycle)

/** Maximum age (seconds) before an unconfirmed pending depeg expires */
export const DEPEG_PENDING_EXPIRY_SEC = 2700; // 45 min (3 sync cycles)

/** Secondary source agreement threshold as fraction of primary threshold */
export const DEPEG_SECONDARY_THRESHOLD_RATIO = 0.5;

// --- Yield Intelligence ---

export const RISK_FREE_RATE_FALLBACK = 3.75;
/** FRED 3-month Treasury yield series (DGS3MO), used by fetch-tbill-rate cron. */
export const FRED_TBILL_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO";
export const TREASURY_YIELD_XML_URL = "https://home.treasury.gov/sites/default/files/interest-rates/yield.xml";
export const FRED_FETCH_TIMEOUT_MS = 15_000;
export const FRED_FETCH_MAX_RETRIES = 2;
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
  CG_DISCOVERY: "coingecko-discovery",
  DEXSCREENER_PRICES: "dexscreener-prices",
  CMC_PRICES: "coinmarketcap-prices",
  TREASURY_RATES: "treasury-rates",
  ETHERSCAN: "etherscan",
  ALCHEMY: "alchemy",
  TWITTER_API: "twitter-api",
  TELEGRAM_API: "telegram-api",
  PYTH_PRICES: "pyth-prices",
  BINANCE_PRICES: "binance-prices",
  KRAKEN_PRICES: "kraken-prices",
  BITSTAMP_PRICES: "bitstamp-prices",
  COINBASE_PRICES: "coinbase-prices",
  REDSTONE_PRICES: "redstone-prices",
  CURVE_ONCHAIN: "curve-onchain",
  CURVE_LIQUIDITY_API: "curve-liquidity-api",
  FX_FRANKFURTER: "fx-frankfurter",
  FX_REALTIME: "fx-realtime",
  CHAINLINK_FEEDS: "chainlink-feeds",
  JUPITER_PRICES: "jupiter-prices",
  GECKO_TERMINAL_PROBE: "geckoterminal-probe",
  FLUID_DEX_API: "fluid-dex-api",
  BALANCER_API: "balancer-api",
  RAYDIUM_API: "raydium-api",
  ORCA_API: "orca-api",
  DRPC: "drpc",
  TRONGRID: "trongrid",
  ANTHROPIC: "anthropic-api",
  BLUECHIP: "bluechip-api",
} as const;

/** Minimum per-pool TVL for DEX pool challenge and pool-level depeg confirmation */
export const POOL_CHALLENGE_MIN_TVL = 100_000; // $100K

/** Minimum TVL for a GeckoTerminal pool to be used as a price cross-check */
export const GT_PROBE_MIN_TVL_USD = 10_000;

/** Maximum time (ms) for a single GT probe request */
export const GT_PROBE_TIMEOUT_MS = 5_000;
