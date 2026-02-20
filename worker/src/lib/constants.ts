/** Minimum peg deviation (in basis points) to trigger a depeg event */
export const DEPEG_THRESHOLD_BPS = 100;

/** Higher threshold for non-USD pegs — FX rate noise + thin liquidity cause more false positives */
export const DEPEG_THRESHOLD_BPS_NON_USD = 150;

/** Returns the appropriate depeg threshold for a given peg type */
export function getDepegThresholdBps(pegType: string | undefined): number {
  return pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
}

/** Maximum age (in seconds) for a DEX price observation to be considered fresh */
export const DEX_FRESHNESS_SEC = 1200;

/** D1 batch statement limit per db.batch() call */
export const D1_BATCH_SIZE = 100;

// --- External API base URLs ---

export const DEFILLAMA_BASE = "https://stablecoins.llama.fi";
export const DEFILLAMA_COINS = "https://coins.llama.fi";
export const DEFILLAMA_API = "https://api.llama.fi";

export const USER_AGENT = "Pharos/1.0 (stablecoin analytics)";

export const RUB_FALLBACK = 0.011;

/** CoinGecko ID overrides for coins with missing or wrong geckoId in DefiLlama */
export const GECKO_ID_OVERRIDES: Record<string, string> = {
  // DefiLlama-listed coins with missing/wrong geckoId
  "226": "frankencoin",              // ZCHF — DL price intermittently returns 0
  "269": "liquity-bold-2",           // BOLD — no geckoId in DL stablecoins API
  "255": "aegis-yusd",               // YUSD — no geckoId in DL stablecoins API
  "275": "quantoz-usdq",             // USDQ — no geckoId in DL stablecoins API
  "302": "hylo-usd",                 // HYUSD — no geckoId in DL stablecoins API
  "342": "megausd",                  // USDM (MegaUSD) — no geckoId in DL stablecoins API
  "185": "gyroscope-gyd",            // GYD — no geckoId in DL stablecoins API
  // Gold tokens — no DL stablecoin entry, need geckoId for price chart backfill
  "gold-xaut": "tether-gold",
  "gold-paxg": "pax-gold",
  "gold-kau":  "kinesis-gold",
  "gold-xaum": "matrixdock-gold",
  "gold-vro":  "veraone",
  "gold-cgo":  "comtech-gold",
  "gold-dgld": "gold-token-sa-dgld-tokenized-gold",
  // Silver tokens
  "silver-kag": "kinesis-silver",
  // CoinGecko-only fiat tokens — no DL stablecoin entry
  "cg-jpyc":  "jpy-coin",
  "cg-idrt":  "rupiah-token",
  "cg-eurq":  "quantoz-eurq",
  "cg-zarp":  "zarp-stablecoin",
  "cg-deuro": "decentralized-euro",
};

/** Minimum number of assets expected from DefiLlama to consider sync valid */
export const MIN_VALID_ASSET_COUNT = 50;

/** DexScreener minimum liquidity threshold in USD for pool validation */
export const DEXSCREENER_MIN_LIQUIDITY_USD = 50_000;

/** Tron burn address (used to exclude from supply calculations) */
export const TRON_BURN_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

/** Coins whose supply must be overridden from on-chain data (DL list endpoint is broken) */
export const SUPPLY_OVERRIDE_COINS: { llamaId: string; geckoId: string; pegKey: string; force?: boolean }[] = [
  { llamaId: "258", geckoId: "a7a5", pegKey: "peggedRUB", force: true }, // DL data unreliable — CG price only, supply from on-chain
];

/** Maximum cache age (in seconds) per cache key — used by both /health and /status endpoints */
export const CACHE_FRESHNESS_THRESHOLDS: Record<string, number> = {
  stablecoins: 600,
  "stablecoin-charts": 600,
  "usds-status": 86400,
  "fx-rates": 14400,
  "bluechip-ratings": 43200,
};
