import { getCacheRatioThresholds } from "./status-thresholds";
import type { CacheStatus, StatusHealthValue } from "../types/status";

export function getCacheFreshnessRatio(
  cache: Pick<CacheStatus, "ageSeconds" | "maxAge">,
): number | null {
  if (cache.ageSeconds == null || !Number.isFinite(cache.maxAge) || cache.maxAge <= 0) {
    return null;
  }
  return cache.ageSeconds / cache.maxAge;
}

export function getCacheFreshnessStatus(
  cache: Pick<CacheStatus, "ageSeconds" | "maxAge">,
  cacheKey?: string,
): StatusHealthValue {
  const ratio = getCacheFreshnessRatio(cache);
  if (ratio == null) return "stale";
  const thresholds = getCacheRatioThresholds(cacheKey);
  if (ratio > thresholds.stale) return "stale";
  if (ratio > thresholds.degraded) return "degraded";
  return "healthy";
}

export function getCacheImpactStatus(cache: CacheStatus, cacheKey?: string): StatusHealthValue {
  const freshnessStatus = getCacheFreshnessStatus(cache, cacheKey);
  if (freshnessStatus === "stale") return "stale";
  if (freshnessStatus === "degraded" || cache.mode === "cached-fallback") {
    return "degraded";
  }
  return "healthy";
}
