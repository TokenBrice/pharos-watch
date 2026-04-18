import { SECONDS } from "./time-constants";
import {
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
} from "@shared/lib/depeg-config";
import {
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  DEPEG_EVENT_MIN_SUPPLY_USD,
  DEPEG_DEX_PROTOCOL_CORROBORATION_MIN,
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEPEG_EXTREME_MOVE_BPS,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
} from "@shared/lib/depeg-detection-config";

/** Returns the appropriate depeg threshold for a given peg type */
export function getDepegThresholdBps(pegType: string | undefined): number {
  return pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
}

export {
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  DEPEG_EVENT_MIN_SUPPLY_USD,
  DEPEG_DEX_PROTOCOL_CORROBORATION_MIN,
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEPEG_EXTREME_MOVE_BPS,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
};
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

// --- Yield Intelligence ---

export const RISK_FREE_RATE_FALLBACK = 3.75;
/** FRED 3-month Treasury yield series (DGS3MO), used by fetch-tbill-rate cron. */
export const FRED_TBILL_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO";
/** Official ECB data API endpoint for 3-month compounded €STR. */
export const ECB_ESTR_3M_CSV_URL = "https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF32.CR?lastNObservations=5&format=csvdata";
export const TREASURY_YIELD_XML_URL = "https://home.treasury.gov/sites/default/files/interest-rates/yield.xml";
/** SIX public OAuth endpoint used to fetch delayed SARON compound-rate downloads as a guest client. */
export const SIX_OAUTH_TOKEN_URL = "https://indexdata.six-group.com/pro/oauth/token";
/** SIX public download broker endpoint for delayed index and rate files. */
export const SIX_REPORT_DOWNLOAD_URL = "https://indexdata.six-group.com/pro/api/report-download";
/** Public browser route used as the referer/origin context for delayed SARON downloads. */
export const SIX_SARON_COMPOUND_RATES_REFERER_URL = "https://indexdata.six-group.com/swiss_reference_rates/compound_rates.html";
/** Full delayed public CSV URL for the 3-month compounded SARON series (SAR3MC). */
export const SIX_SARON_3M_CSV_URL = "https://indexdata.six-group.com/download/saron/h_sar3mc_delayed.csv";
/** SIX guest token and report-download endpoints reject the Pharos UA; use a browser-compatible UA instead. */
export const SIX_BROWSER_USER_AGENT = "Mozilla/5.0";
export const BENCHMARK_FETCH_TIMEOUT_MS = 15_000;
export const BENCHMARK_FETCH_MAX_RETRIES = 2;
export const PYS_SCALING_FACTOR = 8;
/** Default safety score for unrated coins (navTokens, coins with insufficient data). */
export const DEFAULT_SAFETY_SCORE = 40;
/** Minimum report-card score for a coin to qualify for automatic yield discovery (C- = 50). */
export const MIN_SAFETY_SCORE_FOR_YIELD = 50;
/** Minimum APY (%) for auto-discovered lending pools to be eligible. */
export const MIN_LENDING_POOL_APY = 0.1;
/** Minimum TVL (USD) for auto-discovered lending pools to be eligible. */
export const MIN_LENDING_POOL_TVL_USD = 100_000;
/** Lower TVL floor for smaller ecosystems (Solana, Sui, Aptos, Cardano, Stacks). */
export const MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM = 25_000;
/** Minimum lending-opportunity venue size relative to the tracked stablecoin's current supply. */
export const MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY = 0.001;

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
  DEXSCREENER_SEARCH: "dexscreener-search",
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
  CURVE_ORACLE: "curve-oracle",
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
  METEORA_API: "meteora-api",
  PANCAKESWAP_API: "pancakeswap-api",
  AERODROME_SLIPSTREAM_API: "aerodrome-slipstream-api",
  VELODROME_SLIPSTREAM_API: "velodrome-slipstream-api",
  TRONGRID: "trongrid",
  ANTHROPIC: "anthropic-api",
  BLUECHIP: "bluechip-api",
  CG_TICKER: "coingecko-ticker",
  KINESIS_KAU: "kinesis-kau-horizon",
  KINESIS_KAG: "kinesis-kag-horizon",
  COINGECKO_CONFIRM: "coingecko-confirm",
  DEFILLAMA_CONFIRM: "defillama-confirm",
} as const;

export const KINESIS_KAU_HORIZON = "https://kau-mainnet.kinesisgroup.io";
export const KINESIS_KAG_HORIZON = "https://kag-mainnet.kinesisgroup.io";

/** Minimum per-pool TVL for DEX pool challenge and pool-level depeg confirmation */
export const POOL_CHALLENGE_MIN_TVL = 100_000; // $100K

/** Number of qualifying pools that must agree to promote a pending depeg via pool-only confirmation. */
export const POOL_CHALLENGE_CONFIRM_MIN = 2;

/** Single-pool TVL above which pool-only confirmation can promote with a single pool. */
export const POOL_CHALLENGE_HIGH_TVL_USD = 5_000_000; // $5M

/** Maximum accepted block-timestamp staleness for the Curve PriceAggregator EMA oracle (seconds). */
export const CURVE_ORACLE_MAX_STALENESS_SEC = 300;

/** Minimum TVL for a GeckoTerminal pool to be used as a price cross-check */
export const GT_PROBE_MIN_TVL_USD = 10_000;

/** Maximum time (ms) for a single GT probe request */
export const GT_PROBE_TIMEOUT_MS = 5_000;

/** Retries for the serialized GT probe path. */
export const GT_PROBE_MAX_RETRIES = 1;

/** Shared wall-clock budget for the serialized GT probe pass inside sync-stablecoins. */
export const GT_PROBE_RUN_BUDGET_MS = 3 * 60_000;

/**
 * Anthropic digest generation request timeout.
 * Sized under the 15-min Cloudflare scheduled-event ceiling with ~3 min of
 * headroom for persistence, channel delivery, and cron_runs logging. The
 * digest call site overrides the per-attempt fetch timeout so a runaway
 * retry cannot consume the outer budget.
 */
export const ANTHROPIC_TIMEOUT_MS = 12 * 60_000;
