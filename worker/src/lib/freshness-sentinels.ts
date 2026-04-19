import {
  FRESHNESS_SENTINEL_CACHE_KEYS,
  getCacheFreshnessLane,
} from "@shared/lib/api-freshness";

export type FreshnessSentinelBackedCacheKey = (typeof FRESHNESS_SENTINEL_CACHE_KEYS)[number];

function buildFreshnessSentinelConfigs(): Record<
  FreshnessSentinelBackedCacheKey,
  { cacheKey: string; producerJob: string }
> {
  return Object.fromEntries(
    FRESHNESS_SENTINEL_CACHE_KEYS.map((cacheKey) => {
      const lane = getCacheFreshnessLane(cacheKey);
      if (!lane?.freshnessSentinelKey) {
        throw new Error(`Missing freshness sentinel config for ${cacheKey}`);
      }
      return [
        cacheKey,
        {
          cacheKey: lane.freshnessSentinelKey,
          producerJob: lane.producerJob,
        },
      ];
    }),
  ) as Record<FreshnessSentinelBackedCacheKey, { cacheKey: string; producerJob: string }>;
}

export const FRESHNESS_SENTINEL_CONFIGS = buildFreshnessSentinelConfigs();

export function getFreshnessSentinelCacheKey(key: FreshnessSentinelBackedCacheKey): string {
  return FRESHNESS_SENTINEL_CONFIGS[key].cacheKey;
}

export function getFreshnessSentinelProducerJob(key: FreshnessSentinelBackedCacheKey): string {
  return FRESHNESS_SENTINEL_CONFIGS[key].producerJob;
}

export function listFreshnessSentinelCacheKeys(): string[] {
  return Object.values(FRESHNESS_SENTINEL_CONFIGS).map((config) => config.cacheKey);
}
