

// --- Yield Intelligence ---

export const RISK_FREE_RATE_FALLBACK = 3.75;
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

