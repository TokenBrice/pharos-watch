import { STATUS_CACHE_RATIO_THRESHOLDS } from "./status-thresholds";
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
): StatusHealthValue {
  const ratio = getCacheFreshnessRatio(cache);
  if (ratio == null) return "stale";
  if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.stale) return "stale";
  if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.degraded) return "degraded";
  return "healthy";
}

export function getCacheImpactStatus(cache: CacheStatus): StatusHealthValue {
  const freshnessStatus = getCacheFreshnessStatus(cache);
  if (freshnessStatus === "stale") return "stale";
  if (freshnessStatus === "degraded" || cache.mode === "cached-fallback") {
    return "degraded";
  }
  return "healthy";
}
