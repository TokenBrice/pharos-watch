import { describe, expect, it } from "vitest";
import {
  FRESHNESS_RATIOS,
  getBlacklistGapStatus,
  getCacheHealthyMaxRatio,
  getCacheRatioThresholds,
  getHighConfidenceTileSeverity,
  getLowConfidenceTileSeverity,
  getMissingPriceDurationStatus,
  getMissingPriceTileSeverity,
  hasReserveScoreInputHold,
  isReserveDriftThresholdExceeded,
  STATUS_CACHE_RATIO_OVERRIDES,
  STATUS_CACHE_RATIO_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
  STATUS_ONCHAIN_FRESH_WINDOW_SEC,
  STATUS_PRICE_CONFIDENCE_BANDS,
  STATUS_RESERVE_COMPOSITION_THRESHOLDS,
  STATUS_RESERVE_DRIFT_THRESHOLD_POINTS,
} from "../status-thresholds";
import { CRON_INTERVALS } from "../cron-jobs";

it("keeps on-chain supply freshness at two Kinesis producer cycles", () => {
  expect(STATUS_ONCHAIN_FRESH_WINDOW_SEC).toBe(8 * 3600);
  expect(STATUS_ONCHAIN_FRESH_WINDOW_SEC).toBe(2 * CRON_INTERVALS["sync-kinesis-supply"]);
});

describe("missing-price duration bands", () => {
  it("escalates after one day of consecutive missing generations at the sync cadence", () => {
    expect(STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated).toBe(96);
    expect(STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated).toBe(
      (24 * 3600) / CRON_INTERVALS["sync-stablecoins"],
    );
    expect(STATUS_MISSING_PRICE_THRESHOLDS.generationsCritical).toBe(
      7 * STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated,
    );
  });

  it("classifies a single gap by duration at each band boundary", () => {
    const { generationsElevated, generationsCritical } = STATUS_MISSING_PRICE_THRESHOLDS;
    expect(getMissingPriceDurationStatus(generationsElevated - 1)).toBe("healthy");
    expect(getMissingPriceDurationStatus(generationsElevated)).toBe("degraded");
    expect(getMissingPriceDurationStatus(generationsCritical - 1)).toBe("degraded");
    expect(getMissingPriceDurationStatus(generationsCritical)).toBe("stale");
  });

  it("leaves the ratio bands that drive the missing-price rules untouched", () => {
    expect(STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated).toBe(0.15);
    expect(STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded).toBe(0.18);
    expect(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale).toBe(0.45);
  });
});

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

describe("hasReserveScoreInputHold", () => {
  function makeReserve(overrides: Partial<Parameters<typeof hasReserveScoreInputHold>[0]> = {}) {
    return {
      status: "healthy",
      deferredCoins: 0,
      runBudgetTruncated: false,
      writeTimeoutUncertain: 0,
      authoritativeFreshCoverageRatio: 1,
      ...overrides,
    };
  }

  it("treats a healthy lane with partially conservative coverage as clean (live 73.7% shape)", () => {
    expect(hasReserveScoreInputHold(makeReserve({ authoritativeFreshCoverageRatio: 0.7374 }))).toBe(false);
  });

  it("holds only below the documented authoritative coverage threshold", () => {
    expect(hasReserveScoreInputHold(makeReserve({
      authoritativeFreshCoverageRatio: STATUS_RESERVE_COMPOSITION_THRESHOLDS.degradedAuthoritativeCoverageRatio,
    }))).toBe(false);
    expect(hasReserveScoreInputHold(makeReserve({
      authoritativeFreshCoverageRatio: STATUS_RESERVE_COMPOSITION_THRESHOLDS.degradedAuthoritativeCoverageRatio - 0.0001,
    }))).toBe(true);
  });

  it("holds on each operational hold condition regardless of coverage", () => {
    expect(hasReserveScoreInputHold(makeReserve({ status: "degraded" }))).toBe(true);
    expect(hasReserveScoreInputHold(makeReserve({ status: "stale" }))).toBe(true);
    expect(hasReserveScoreInputHold(makeReserve({ deferredCoins: 1 }))).toBe(true);
    expect(hasReserveScoreInputHold(makeReserve({ runBudgetTruncated: true }))).toBe(true);
    expect(hasReserveScoreInputHold(makeReserve({ writeTimeoutUncertain: 1 }))).toBe(true);
  });
});

describe("price confidence tile severity", () => {
  it("classifies High by circulating-value share, not asset-count share", () => {
    // Illustrative long-tail distribution: low row-share, high value-share.
    expect(getHighConfidenceTileSeverity(96.5)).toBe("green");
    expect(getHighConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.highMcapShareGreenPct)).toBe("green");
    expect(getHighConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.highMcapShareGreenPct - 0.1)).toBe("amber");
    expect(getHighConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.highMcapShareAmberPct)).toBe("amber");
    expect(getHighConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.highMcapShareAmberPct - 0.1)).toBe("red");
  });

  it("treats a legacy payload without market-cap sums as unknown rather than red", () => {
    expect(getHighConfidenceTileSeverity(null)).toBe("neutral");
    expect(getHighConfidenceTileSeverity(Number.NaN)).toBe("neutral");
  });

  it("keeps Low neutral until low-confidence marks carry material value", () => {
    // A large row count can still have small economic exposure.
    expect(getLowConfidenceTileSeverity(0.05)).toBe("neutral");
    expect(getLowConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.lowMcapShareAmberPct - 0.01)).toBe("neutral");
    expect(getLowConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.lowMcapShareAmberPct)).toBe("amber");
    expect(getLowConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.lowMcapShareRedPct - 0.01)).toBe("amber");
    expect(getLowConfidenceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.lowMcapShareRedPct)).toBe("red");
    expect(getLowConfidenceTileSeverity(null)).toBe("neutral");
  });

  it("alarms on the unacknowledged missing-price count only", () => {
    expect(getMissingPriceTileSeverity(0)).toBe("green");
    expect(getMissingPriceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.missingCountAmber)).toBe("amber");
    expect(getMissingPriceTileSeverity(STATUS_PRICE_CONFIDENCE_BANDS.missingCountAmber + 1)).toBe("red");
  });
});
