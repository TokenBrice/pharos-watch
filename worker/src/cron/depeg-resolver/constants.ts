import { API_FRESHNESS_MAX_AGE_SEC, CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";

export const TRAINING_WINDOW_SEC = 4 * 365 * 86400;
export const HISTORICAL_ROW_CAP = 60000;
export const DAY = 86400;
export const CURRENT_PRICE_MAX_AGE_SEC = CACHE_FRESHNESS_LANES.stablecoins.producerIntervalSec;
export const DDR_SNAPSHOT_TTL_SEC = API_FRESHNESS_MAX_AGE_SEC.depegResolver;
export const DEWS_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.stressSignals;
export const DEX_LIQUIDITY_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.dexLiquidity;
export const REDEMPTION_BACKSTOP_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops;
