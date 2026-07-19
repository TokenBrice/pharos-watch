import { describe, expect, it } from "vitest";
import {
  FRESHNESS_RATIOS,
  getBlacklistGapStatus,
  getCacheHealthyMaxRatio,
  getCacheRatioThresholds,
  isReserveDriftThresholdExceeded,
  STATUS_CACHE_RATIO_OVERRIDES,
  STATUS_CACHE_RATIO_THRESHOLDS,
  STATUS_RESERVE_DRIFT_THRESHOLD_POINTS,
} from "../status-thresholds";

describe("getBlacklistGapStatus", () => {
  it("returns healthy for historical low-ratio blacklist gaps", () => {
    expect(getBlacklistGapStatus({
      missingRatio: 0.005,
      recentMissingAmounts: 0,
    })).toBe("healthy");
  });

  it("stays healthy for isolated recent blacklist gaps below the degraded floor", () => {
    expect(getBlacklistGapStatus({
      missingRatio: 0.005,
      recentMissingAmounts: 1,
    })).toBe("healthy");
  });

  it("returns degraded when recent blacklist gaps cross the degraded floor", () => {
    expect(getBlacklistGapStatus({
      missingRatio: 0.005,
      recentMissingAmounts: 5,
    })).toBe("degraded");
  });

  it("returns degraded when the missing-ratio warning threshold is crossed", () => {
    expect(getBlacklistGapStatus({
      missingRatio: 0.01,
      recentMissingAmounts: 0,
    })).toBe("degraded");
  });

  it("returns stale when the stale thresholds are crossed", () => {
    expect(getBlacklistGapStatus({
      missingRatio: 0.02,
      recentMissingAmounts: 0,
    })).toBe("stale");

    expect(getBlacklistGapStatus({
      missingRatio: 0.005,
      recentMissingAmounts: 25,
    })).toBe("stale");
  });
});

describe("per-cache availability ratio overrides", () => {
  it("returns the global bands for caches without an override", () => {
    expect(getCacheRatioThresholds()).toEqual(STATUS_CACHE_RATIO_THRESHOLDS);
    expect(getCacheRatioThresholds("stablecoins")).toEqual(STATUS_CACHE_RATIO_THRESHOLDS);
  });

  it("tightens yield-data to 2x degraded / 4x stale (two missed hourly publishes)", () => {
    expect(STATUS_CACHE_RATIO_OVERRIDES["yield-data"]).toEqual({ degraded: 2.0, stale: 4.0 });
    expect(getCacheRatioThresholds("yield-data")).toEqual({ degraded: 2.0, stale: 4.0 });
  });

  it("flips the yield-data healthy boolean at the degraded band while others keep the not-stale ceiling", () => {
    expect(getCacheHealthyMaxRatio("yield-data")).toBe(2.0);
    expect(getCacheHealthyMaxRatio("stablecoins")).toBe(FRESHNESS_RATIOS.DEGRADED);
    expect(getCacheHealthyMaxRatio()).toBe(FRESHNESS_RATIOS.DEGRADED);
  });
});

describe("isReserveDriftThresholdExceeded", () => {
  it("keeps the reserve drift watch threshold at greater than 15 points", () => {
    expect(STATUS_RESERVE_DRIFT_THRESHOLD_POINTS).toBe(15);
    expect(isReserveDriftThresholdExceeded(STATUS_RESERVE_DRIFT_THRESHOLD_POINTS)).toBe(false);
    expect(isReserveDriftThresholdExceeded(STATUS_RESERVE_DRIFT_THRESHOLD_POINTS + 0.1)).toBe(true);
  });
});
