import {
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
  DEPEG_RECOVERY_THRESHOLD_RATIO,
} from "@shared/lib/depeg-config";

/** Maximum open depeg events materialized by one detection, confirmation, or orphan-cleanup pass. */
export const MAX_OPEN_DEPEG_EVENTS = 200;

/** Returns the appropriate depeg threshold for a given peg type */
export function getDepegThresholdBps(pegType: string | undefined): number {
  return pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
}

export function getDepegThresholdBpsForPegCurrency(pegCurrency: string | undefined): number {
  return getDepegThresholdBps(pegCurrency === "USD" ? "peggedUSD" : undefined);
}

export function getDepegRecoveryThresholdBps(pegType: string | undefined): number {
  return Math.round(getDepegThresholdBps(pegType) * DEPEG_RECOVERY_THRESHOLD_RATIO);
}

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
export const STELLAR_HORIZON_API = "https://horizon.stellar.org";

export const USER_AGENT = "Pharos/1.0 (stablecoin analytics)";

/** Minimum number of assets expected from DefiLlama to consider sync valid */
export const MIN_VALID_ASSET_COUNT = 50;

/** DexScreener minimum liquidity threshold in USD for pool validation */
export const DEXSCREENER_MIN_LIQUIDITY_USD = 50_000;

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
export const ECB_ESTR_3M_CSV_URL =
  "https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF32.CR?lastNObservations=5&format=csvdata";
export const TREASURY_YIELD_XML_URL = "https://home.treasury.gov/sites/default/files/interest-rates/yield.xml";
/** SIX public OAuth endpoint used to fetch delayed SARON compound-rate downloads as a guest client. */
export const SIX_OAUTH_TOKEN_URL = "https://indexdata.six-group.com/pro/oauth/token";
/** SIX public download broker endpoint for delayed index and rate files. */
export const SIX_REPORT_DOWNLOAD_URL = "https://indexdata.six-group.com/pro/api/report-download";
/** Public browser route used as the referer/origin context for delayed SARON downloads. */
export const SIX_SARON_COMPOUND_RATES_REFERER_URL =
  "https://indexdata.six-group.com/swiss_reference_rates/compound_rates.html";
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

export { CIRCUIT_SOURCE } from "@shared/lib/circuit-sources";

export const KINESIS_KAU_HORIZON = "https://kau-mainnet.kinesisgroup.io";
export const KINESIS_KAG_HORIZON = "https://kag-mainnet.kinesisgroup.io";

/** Minimum per-pool TVL for DEX pool challenge and pool-level depeg confirmation */
export const POOL_CHALLENGE_MIN_TVL = 100_000; // $100K

/** Number of qualifying pools that must agree to promote a pending depeg via pool-only confirmation. */
const POOL_CHALLENGE_CONFIRM_MIN = 2;

/** Single-pool TVL above which pool-only confirmation can promote with a single pool. */
export const POOL_CHALLENGE_HIGH_TVL_USD = 5_000_000; // $5M

/**
 * One authority for the diverging-vs-corroborating protocol-group precedence rule
 * shared by price hardening (`selectReplacementProtocolGroups` and its confidence
 * downgrade), pending-depeg pool confirmation, and the primary-recovery pool veto.
 *
 * 2026-09-24 (vchf-vnx): two dormant protocols whose last trade is months old and
 * whose provider-reported reserves cannot carry a decision — the Celo Uniswap v3
 * VCHF/USD₮ pool (last trade 2026-03-15, provider-reported $4.7M reserve against
 * ~$141 on-chain, 24h volume 0) and the ICP kongswap VCHF/ICP pool (24h volume 0)
 * — both replaced a four-protocol consensus that matched the ECB CHF rate and
 * then vetoed its recovery. A diverging set must therefore both reach
 * `POOL_CHALLENGE_CONFIRM_MIN` independent groups and be at least as numerous as
 * the groups whose medians corroborate the current/recovered price before it can
 * carry a depeg decision. Callers keep their own high-TVL directional carve-outs.
 *
 * The bar is `POOL_CHALLENGE_CONFIRM_MIN` (2), which both lanes share: a future
 * depeg-lane retune of that constant also moves the pricing replacement bar.
 */
export function divergingProtocolGroupsOutvote(params: {
  divergingCount: number;
  corroboratingCount: number;
}): boolean {
  return params.divergingCount >= POOL_CHALLENGE_CONFIRM_MIN &&
    params.divergingCount >= params.corroboratingCount;
}

/**
 * The complement of `divergingProtocolGroupsOutvote`: at least
 * `POOL_CHALLENGE_CONFIRM_MIN` independent groups corroborate the current price
 * and strictly outnumber the diverging set, so the losing diverging minority may
 * neither replace the price nor downgrade its confidence tier — that tier is what
 * the depeg recovery gate consumes. A tie or a diverging majority is not outvoted
 * and still downgrades/replaces exactly as before. Any real replacement still
 * downgrades, because the replacement decision itself is unchanged.
 */
export function corroboratingProtocolGroupsOutvote(params: {
  divergingCount: number;
  corroboratingCount: number;
}): boolean {
  return params.corroboratingCount >= POOL_CHALLENGE_CONFIRM_MIN &&
    params.corroboratingCount > params.divergingCount;
}

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

/**
 * Anthropic digest generation request timeout.
 * Sized under the 15-min Cloudflare scheduled-event ceiling with ~3 min of
 * headroom for persistence, channel delivery, and cron_runs logging. The
 * digest call site overrides the per-attempt fetch timeout so a runaway
 * retry cannot consume the outer budget.
 */
export const ANTHROPIC_TIMEOUT_MS = 12 * 60_000;

export const DIGEST_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type DigestEffort = (typeof DIGEST_EFFORT_LEVELS)[number];

export interface DigestLlmConfig {
  model: string;
  effort: DigestEffort;
  maxTokens: number;
}

/**
 * Opus 5.5 runs streaming safety classifiers that can refuse a request. The
 * digest request path handles that policy outcome separately from provider
 * failures so it cannot poison the Anthropic circuit breaker.
 */
export const DIGEST_MODEL = "claude-opus-5-5";

/**
 * Per-request output ceiling (thinking + visible text) for both digest jobs,
 * and the upper bound for runtime `maxTokens` overrides. A `max_tokens` stop
 * loses the edition, so this sits about 2.5x above the largest Opus 5.5 `high`
 * generation measured on production prompts (6,455 tokens, weekly 2026-09-07).
 */
export const DIGEST_MAX_TOKENS = 16_000;

/**
 * Output tokens one edition may bill across every attempt: the original leg,
 * the corrective retry, and any HTTP retry of either. A request starts only
 * when its full `max_tokens` still fits. Two full requests means a corrective
 * retry always fits after a completed first pass, and one retry fits after a
 * request whose usage never came back (charged the full ceiling).
 *
 * `max_tokens` alone does not bound spend: up to `DIGEST_FETCH_MAX_RETRIES + 1`
 * generations per leg across two legs can bill. With six billed input charges
 * at the largest observed prompts, 32,000 output tokens puts one invocation per
 * edition at about $1.12/day (daily plus weekly/7) at Opus 5.5 prices, under
 * the $1.15 ceiling. Extra invocations (manual force-runs, Monday weekly
 * resumes) each carry their own budget, and a mid-output server-side fallback
 * can bill one extra partial generation inside a request before it is charged.
 */
export const DIGEST_MAX_EDITION_OUTPUT_TOKENS = 2 * DIGEST_MAX_TOKENS;

/**
 * `high`, not `xhigh`: on the same production prompts Opus 5.5 at `xhigh`
 * emitted 11-12k output tokens per daily and 19,996 on the heaviest weekly
 * (up to 2.8x Opus 5 at `xhigh`), which no ceiling inside the cost envelope
 * can hold. At `high` it emitted 3.5-6.5k, and kept the forward-look line on
 * two of three sampled dailies where Opus 5 at `xhigh` kept it on none.
 */
export const DAILY_DIGEST_LLM_CONFIG: DigestLlmConfig = {
  model: DIGEST_MODEL,
  effort: "high",
  maxTokens: DIGEST_MAX_TOKENS,
};

export const WEEKLY_RECAP_LLM_CONFIG: DigestLlmConfig = {
  model: DIGEST_MODEL,
  effort: "high",
  maxTokens: DIGEST_MAX_TOKENS,
};
