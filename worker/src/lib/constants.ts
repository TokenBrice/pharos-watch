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
  "usds-status": 86400,
  "fx-rates": 1800,
  "bluechip-ratings": 86400,
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

// --- Circuit breaker source names ---

export const CIRCUIT_SOURCE = {
  DL_STABLECOINS: "defillama-stablecoins",
  DL_COINS: "defillama-coins",
  DL_YIELDS: "defillama-yields",
  DL_PROTOCOLS: "defillama-protocols",
  CG_PRICES: "coingecko-prices",
  CG_MCAP: "coingecko-mcap",
} as const;
