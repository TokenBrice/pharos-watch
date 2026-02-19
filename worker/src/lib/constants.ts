/** Minimum peg deviation (in basis points) to trigger a depeg event */
export const DEPEG_THRESHOLD_BPS = 100;

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
  "226": "frankencoin",              // ZCHF — DL price intermittently returns 0
  "269": "liquity-bold-2",           // BOLD — no geckoId in DL stablecoins API
  "255": "aegis-yusd",               // YUSD — no geckoId in DL stablecoins API
  "275": "quantoz-usdq",             // USDQ — no geckoId in DL stablecoins API
  "302": "hylo-usd",                 // HYUSD — no geckoId in DL stablecoins API
  "342": "megausd",                  // USDM (MegaUSD) — no geckoId in DL stablecoins API
  "185": "gyroscope-gyd",            // GYD — no geckoId in DL stablecoins API
};
