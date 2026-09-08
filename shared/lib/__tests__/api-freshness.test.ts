import { describe, expect, it } from "vitest";
import {
  API_FRESHNESS_MAX_AGE_SEC,
  CACHE_AVAILABILITY_MAX_AGE_SEC,
  CACHE_FRESHNESS_LANES,
  FRESHNESS_SENTINEL_CACHE_KEYS,
  getCacheFreshnessLane,
  isFreshnessWarningHeader,
} from "../api-freshness";
import { CRON_INTERVALS } from "../cron-jobs";

describe("api-freshness", () => {
  it("keeps DEWS endpoint and availability freshness aligned to the compute cadence", () => {
    expect(API_FRESHNESS_MAX_AGE_SEC.stressSignals).toBe(CRON_INTERVALS["compute-dews"]);
    expect(CACHE_AVAILABILITY_MAX_AGE_SEC.dews).toBe(CRON_INTERVALS["compute-dews"]);
    expect(CACHE_FRESHNESS_LANES.dews.endpointMaxAgeSec).toBe(CRON_INTERVALS["compute-dews"]);
    expect(CACHE_FRESHNESS_LANES.dews.availabilityMaxAgeSec).toBe(CRON_INTERVALS["compute-dews"]);
  });

  it("preserves intentional endpoint-vs-availability budget differences", () => {
    expect(CACHE_FRESHNESS_LANES.dexLiquidity.endpointMaxAgeSec).toBe(4 * 3600);
    expect(CACHE_FRESHNESS_LANES.dexLiquidity.availabilityMaxAgeSec).toBe(12 * 3600);
    expect(CACHE_FRESHNESS_LANES.bluechipRatings.endpointMaxAgeSec).toBe(12 * 3600);
    expect(CACHE_FRESHNESS_LANES.bluechipRatings.availabilityMaxAgeSec).toBe(24 * 3600);
  });

  it("keeps stablecoins on its existing stricter public freshness contract", () => {
    expect(API_FRESHNESS_MAX_AGE_SEC.stablecoins).toBe(600);
    expect(CACHE_AVAILABILITY_MAX_AGE_SEC.stablecoins).toBe(600);
    expect(CACHE_FRESHNESS_LANES.stablecoins.producerIntervalSec).toBe(CRON_INTERVALS["sync-stablecoins"]);
  });

  it("declares producer jobs for sentinel-backed freshness lanes", () => {
    expect(FRESHNESS_SENTINEL_CACHE_KEYS).toEqual(["dex-liquidity", "yield-data", "dews"]);
    for (const cacheKey of FRESHNESS_SENTINEL_CACHE_KEYS) {
      const lane = Object.values(CACHE_FRESHNESS_LANES).find((entry) => entry.cacheKey === cacheKey);
      const sentinelKey = lane && "freshnessSentinelKey" in lane ? lane.freshnessSentinelKey : null;
      expect(sentinelKey).toBe(`freshness:${cacheKey}`);
      expect(lane?.producerJob).toBeTruthy();
    }
  });
});

describe("getCacheFreshnessLane", () => {
  it("returns the freshness lane registered for a cache key", () => {
    expect(getCacheFreshnessLane("dex-liquidity")).toBe(CACHE_FRESHNESS_LANES.dexLiquidity);
    expect(getCacheFreshnessLane("dews")?.producerJob).toBe("compute-dews");
  });

  it("returns null for cache keys without a freshness lane", () => {
    expect(getCacheFreshnessLane("not-a-lane")).toBeNull();
  });
});

describe("isFreshnessWarningHeader", () => {
  it("flags warn-code 110 at the start of any comma-separated Warning element", () => {
    expect(isFreshnessWarningHeader('110 - "Revalidation failed"')).toBe(true);
    expect(isFreshnessWarningHeader('199 - "Misc", 110 - "Revalidation failed"')).toBe(true);
  });

  it("flags the shared degraded/stale warning texts case-insensitively", () => {
    expect(isFreshnessWarningHeader('Response is stale')).toBe(true);
    expect(isFreshnessWarningHeader('Response is DEGRADED')).toBe(true);
  });

  it("ignores other warn codes and unrelated warning text", () => {
    expect(isFreshnessWarningHeader('199 - "Misc warning"')).toBe(false);
    expect(isFreshnessWarningHeader('1100 - "not warn-code 110"')).toBe(false);
    expect(isFreshnessWarningHeader("Response is fresh")).toBe(false);
  });
});
