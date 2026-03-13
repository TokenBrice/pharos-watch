export const BLACKLIST_RECENT_WINDOW_SEC = 24 * 3600;

export const STATUS_BLACKLIST_THRESHOLDS = {
  missingRatioDegraded: 0.005,
  missingRatioStale: 0.02,
  missingRecentStale: 25,
} as const;

export const STATUS_ONCHAIN_THRESHOLDS = {
  ratioDegraded: 0.1,
  ratioStale: 0.25,
  staleAbsoluteStale: 10,
  divergenceAbsoluteStale: 25,
} as const;

export const STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC = 3 * 24 * 3600;
export const STATUS_ONCHAIN_FRESH_WINDOW_SEC = 2 * 3600;
export const STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD = 0.05;
