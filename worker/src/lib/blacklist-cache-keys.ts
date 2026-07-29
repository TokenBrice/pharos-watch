import { BLACKLIST_RECENT_WINDOW_SEC } from "@shared/lib/status-thresholds";

export const BLACKLIST_GAP_METRICS_CACHE_VERSION = 1;
export const BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION = 1;
export const BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY =
  `blacklist:summary:producer:v${BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION}`;

export type BlacklistGapMetricsCacheKind = "producer" | "request";

export function getBlacklistGapMetricsCacheKey(
  options: { recentWindowSec: number; includeDistributions: boolean },
  kind: BlacklistGapMetricsCacheKind,
): string {
  if (kind === "producer") {
    return `blacklist:gap-metrics:producer:v${BLACKLIST_GAP_METRICS_CACHE_VERSION}:${options.recentWindowSec}:${options.includeDistributions ? "full" : "core"}`;
  }
  return `blacklist:gap-metrics:v${BLACKLIST_GAP_METRICS_CACHE_VERSION}:${options.recentWindowSec}:${options.includeDistributions ? "full" : "core"}`;
}

export function getBlacklistDerivedCacheKeys(recentWindowSec = BLACKLIST_RECENT_WINDOW_SEC): string[] {
  const metricOptions = [
    { recentWindowSec, includeDistributions: false },
    { recentWindowSec, includeDistributions: true },
  ];
  return [
    BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY,
    ...metricOptions.flatMap((options) => [
      getBlacklistGapMetricsCacheKey(options, "producer"),
      getBlacklistGapMetricsCacheKey(options, "request"),
    ]),
  ];
}
