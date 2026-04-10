export const FRESHNESS_SENTINEL_CONFIGS = {
  "dex-liquidity": {
    cacheKey: "freshness:dex-liquidity",
    producerJob: "sync-dex-liquidity",
  },
  "yield-data": {
    cacheKey: "freshness:yield-data",
    producerJob: "sync-yield-data",
  },
  dews: {
    cacheKey: "freshness:dews",
    producerJob: "compute-dews",
  },
} as const;

export type FreshnessSentinelBackedCacheKey = keyof typeof FRESHNESS_SENTINEL_CONFIGS;

export function getFreshnessSentinelCacheKey(key: FreshnessSentinelBackedCacheKey): string {
  return FRESHNESS_SENTINEL_CONFIGS[key].cacheKey;
}

export function getFreshnessSentinelProducerJob(key: FreshnessSentinelBackedCacheKey): string {
  return FRESHNESS_SENTINEL_CONFIGS[key].producerJob;
}

export function listFreshnessSentinelCacheKeys(): string[] {
  return Object.values(FRESHNESS_SENTINEL_CONFIGS).map((config) => config.cacheKey);
}
