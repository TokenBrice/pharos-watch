import { API_CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { CACHE_AVAILABILITY_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
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
} from "@shared/lib/depeg-config";

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

/**
 * Cache-table key prefix for per-coin detail cache write-failure markers.
 * Written by the detail handler on skipped/failed writes; scanned by the
 * cron staleness watchdog, which alerts on fresh markers.
 */
export const DETAIL_WRITE_FAILURE_KEY_PREFIX = "detail-write-failure:";

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
export const CACHE_PROFILES = API_CACHE_PROFILES;

/** Maximum cache age (in seconds) per cache key — used by both /health and /status endpoints */
export const CACHE_FRESHNESS_THRESHOLDS: Record<string, number> = CACHE_AVAILABILITY_MAX_AGE_SEC;

// --- Depeg multi-source confirmation (>$1B coins) ---

// --- Yield Intelligence ---

export const RISK_FREE_RATE_FALLBACK = 3.75;
/** FRED 3-month Treasury yield series (DGS3MO), used by fetch-tbill-rate cron. */
export const FRED_TBILL_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO";
/** Official New York Fed latest Effective Federal Funds Rate endpoint, used for EFFR-linked yield products. */
export const NYFED_EFFR_JSON_URL = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json";
/** FRED Effective Federal Funds Rate series (DFF), retained as the USD_EFFR fallback feed. */
export const FRED_EFFR_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF";
/**
 * FRED mirror of the Bank of England SONIA Compounded Index (series IUDZOS2),
 * used as the primary GBP benchmark feed because the BoE IADB host blocks
 * Cloudflare Worker egress. Same series the BoE source derives from.
 */
export const FRED_SONIA_COMPOUNDED_INDEX_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2";
/** ALFRED graph CSV mirror of the same Bank of England SONIA Compounded Index series. */
export const ALFRED_SONIA_COMPOUNDED_INDEX_CSV_URL = "https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2";
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
/** Bank of England SONIA dataset CSV endpoint (base path; date filters added at runtime). */
export const BOE_SONIA_CSV_BASE_URL = "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp";
/** Bank of Japan daily call-rate JSON endpoint (base path; query filters added at runtime). */
export const BOJ_CALL_RATE_JSON_BASE_URL = "https://www.stat-search.boj.or.jp/api/v1/getDataCode";
/** Reserve Bank of Australia F1 money-market CSV endpoint. */
export const RBA_F1_MONEY_MARKET_CSV_URL = "https://www.rba.gov.au/statistics/tables/csv/f1-data.csv";
/** Banxico SIE API — CETES 28-day primary auction yield (series SF43936). Requires Bmx-Token header. */
export const BANXICO_CETES_28D_URL = "https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43936/datos/oportuno";
/** Etherfuse app route whose Next data exposes the current CETES Stablebond issuance rate. */
export const ETHERFUSE_CETES_BOND_PAGE_URL = "https://app.etherfuse.com/bonds/cetes";
/** Banco Central do Brasil SGS — SELIC over (series 11), latest daily observation as JSON. */
export const BCB_SELIC_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/1?formato=json";
/** Bank of Canada Valet — overnight repo rate (V122530), latest observation as JSON. */
export const BOC_CORRA_URL = "https://www.bankofcanada.ca/valet/observations/V122530/json?recent=1";
/** Central Bank of Russia DailyInfo SOAP endpoint for KeyRateXML observations. */
export const CBR_DAILY_INFO_SOAP_URL = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx";
/** CBRT EVDS3 frontend data endpoint used for BIST TLREF benchmark observations. */
export const CBRT_EVDS_FE_URL = "https://evds3.tcmb.gov.tr/igmevdsms-dis/fe";
/** EVDS series code for BIST TLREF, the Turkish Lira Overnight Reference Rate. */
export const CBRT_TLREF_SERIES_CODE = "TP.BISTTLREF.ORAN";
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
/** Lower TVL floor for explicitly configured smaller or pre-mainnet ecosystems. */
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
  CG_ONCHAIN: "coingecko-onchain",
  DEXSCREENER_PRICES: "dexscreener-prices",
  DEXSCREENER_LIQUIDITY: "dexscreener-liquidity",
  DEXSCREENER_ADDRESS_PRICES: "dexscreener-address-prices",
  DEXPAPRIKA_PRICES: "dexpaprika-prices",
  ALCHEMY_PRICES: "alchemy-prices",
  MORALIS_PRICES: "moralis-prices",
  BIRDEYE_PRICES: "birdeye-prices",
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
  KAVA_PRICEFEED: "kava-pricefeed",
  JUSD_CITREA_BRIDGE: "jusd-citrea-bridge",
  USX_STABLE_POOLS: "usx-stable-pools",
  AZND_CURVE_POOL: "aznd-curve-pool",
  MENTO_BROKER: "mento-broker",
  PROTOCOL_REDEEM: "protocol-redeem",
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
  VAULTS_FYI: "vaults-fyi",
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

/** Cross-asset contagion amplifier applied to a same-peg-type coin when another is DANGER. */
export const CONTAGION_BUMP_DANGER = 1.15;

/** Cross-asset contagion amplifier applied to a same-peg-type coin when another is WARNING. */
export const CONTAGION_BUMP_WARNING = 1.08;

/** Upper cap on the cross-asset contagion amplifier (applied after bump selection). */
export const CONTAGION_AMPLIFIER_CAP = 1.2;

/** Days of stress_signal_history examined before each backtest anchor's onset. */
export const BACKTEST_LOOKBACK_DAYS = 14;

/** Maximum accepted block-timestamp staleness for the Curve PriceAggregator EMA oracle (seconds). */
export const CURVE_ORACLE_MAX_STALENESS_SEC = 300;

/** Minimum TVL for a GeckoTerminal pool to be used as a price cross-check */
export const GT_PROBE_MIN_TVL_USD = 10_000;

/** Maximum time (ms) for a single GT probe request */
export const GT_PROBE_TIMEOUT_MS = 5_000;

/** Retries for the serialized GT probe path. */
export const GT_PROBE_MAX_RETRIES = 1;

/** Shared wall-clock budget for the serialized GT probe pass inside sync-stablecoins. */
export const GT_PROBE_RUN_BUDGET_MS = 90_000;

/**
 * Anthropic digest generation request timeout.
 * Sized under the 15-min Cloudflare scheduled-event ceiling with ~3 min of
 * headroom for persistence, channel delivery, and cron_runs logging. The
 * digest call site overrides the per-attempt fetch timeout so a runaway
 * retry cannot consume the outer budget.
 */
export const ANTHROPIC_TIMEOUT_MS = 12 * 60_000;

/**
 * Anthropic model used for digest/recap editorial generation.
 * Single source of truth shared by the implementation and its tests so a model
 * upgrade is a one-line change. A deliberate product decision, not an env var.
 */
export const DIGEST_MODEL = "claude-opus-4-7";
