// --- Blacklist gap thresholds ---
export const BLACKLIST_RECENT_WINDOW_SEC = 24 * 3600;
export const STATUS_BLACKLIST_THRESHOLDS = {
  missingRatioDegraded: 0.005,
  missingRatioStale: 0.02,
  missingRecentStale: 25,
} as const;

// --- On-chain supply thresholds ---
export const STATUS_ONCHAIN_THRESHOLDS = {
  ratioDegraded: 0.1,
  ratioStale: 0.25,
  staleAbsoluteStale: 10,
  divergenceAbsoluteStale: 25,
} as const;
export const STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC = 3 * 24 * 3600;
export const STATUS_ONCHAIN_FRESH_WINDOW_SEC = 2 * 3600;
export const STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD = 0.05;

// --- Missing price thresholds ---
export const STATUS_MISSING_PRICE_THRESHOLDS = {
  ratioDegraded: 0.15,
  ratioStale: 0.4,
} as const;

// --- Cache ratio thresholds (availability status) ---
export const STATUS_CACHE_RATIO_THRESHOLDS = {
  degraded: 1.5,
  stale: 2,
} as const;

// --- Price source confidence severity bands (UI visual indicators) ---
export const STATUS_PRICE_CONFIDENCE_BANDS = {
  highPctGreen: 85,
  highPctAmber: 70,
  missingCountAmber: 3,
  lowCountAmber: 5,
  lowCountRed: 10,
} as const;

// --- Mint/burn reconciliation thresholds ---
export const STATUS_RECONCILIATION_THRESHOLDS = {
  criticalAbsoluteUsd: 100_000_000,
  criticalRatio: 0.3,
  warnAbsoluteUsd: 25_000_000,
  warnRatio: 0.12,
} as const;

// --- Discovery scan ---
export const DISCOVERY_MIN_MCAP = 5_000_000;
