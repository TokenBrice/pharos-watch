import { describe, expect, it } from "vitest";
import {
  FRESHNESS_RATIOS,
  getBlacklistGapStatus,
  getStablecoinPublicationImpactStatus,
  getActivePriceCoverageBreadthStatus,
  getActiveAssetServiceBreadthThreshold,
  getCriticalDurationActivePriceGapIds,
  hasActivePriceGapMarketCapEvidence,
  STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC,
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
import type { ActivePriceCoverageGap } from "../../types/status";

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
    expect(getMissingPriceDurationStatus(null)).toBe("degraded");
  });

  it("keeps only the stale ratio band for missing prices", () => {
    expect(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale).toBe(0.45);
    expect(Object.keys(STATUS_MISSING_PRICE_THRESHOLDS)).not.toContain("ratioDegraded");
  });

  it.each([
    ["complete", 0, "healthy"], ["incomplete", 4, "healthy"], ["incomplete", 19, "healthy"],
    ["incomplete", 20, "degraded"], ["unknown", null, "healthy"],
  ] as const)("grades %s price coverage with %s unavailable of 396 by cohort breadth", (status, missingPriceCount, expected) => {
    expect(getActivePriceCoverageBreadthStatus({
      status, expectedActiveCount: status === "unknown" ? null : 396, missingPriceCount,
    })).toBe(expected);
  });
});

describe("publication breadth and market-cap evidence", () => {
  const now = 1_790_000_000;
  it("no longer carries a single-asset market-cap materiality threshold", () => {
    expect(Object.keys(STATUS_MISSING_PRICE_THRESHOLDS)).not.toContain("durationMaterialMarketCapUsd");
  });
  it.each([
    [now, 60_000_000, true],
    [now - STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC, 30_000_000, true],
    [now - STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC - 1, 30_000_000, false],
    [now + 1, 30_000_000, false],
    [null, 30_000_000, false],
  ])("admits dated producer evidence without renewing its clock (%s)", (observedAt, cap, expected) => {
    expect(hasActivePriceGapMarketCapEvidence({
      marketCapUsd: null, lastKnownMarketCapUsd: cap, lastKnownMarketCapObservedAt: observedAt,
    }, now)).toBe(expected);
  });
  it("treats a current-generation cap as evidence", () => {
    expect(hasActivePriceGapMarketCapEvidence({
      marketCapUsd: 60_000_000, lastKnownMarketCapUsd: null, lastKnownMarketCapObservedAt: null,
    }, now)).toBe(true);
  });
  it.each(["unknown", "incomplete"] as const)("fails closed for %s publication without ids", (status) => {
    expect(getStablecoinPublicationImpactStatus({ status, missingActiveIds: [], expectedActiveCount: 396 })).toBe("degraded");
  });
  it.each([
    [1, 396, "healthy"], [4, 396, "healthy"], [19, 396, "healthy"], [20, 396, "degraded"],
    [20, 401, "healthy"], [21, 401, "degraded"], [4, 100, "healthy"], [5, 100, "degraded"], [1, 10, "degraded"],
    [1, 0, "degraded"],
  ] as const)("bounds listing impact by breadth alone (%s missing of %s)", (count, expectedActiveCount, expected) => {
    const missingActiveIds = Array.from({ length: count }, (_, index) => `missing-${index}`);
    expect(getStablecoinPublicationImpactStatus({ status: "incomplete", missingActiveIds, expectedActiveCount })).toBe(expected);
  });
  it.each([[0, null], [-1, null], [null, null], [10, 1], [100, 5], [396, 20], [400, 20], [401, 21], [800, 40]] as const)(
    "derives the service-wide breadth threshold (%s expected)", (expectedActiveCount, threshold) => {
      expect(getActiveAssetServiceBreadthThreshold(expectedActiveCount)).toBe(threshold);
    });
});

describe("critical-duration gap ids", () => {
  const gap = (stablecoinId: string, consecutiveMissingGenerations: number | null, extra: Partial<ActivePriceCoverageGap> = {}): ActivePriceCoverageGap => ({
    stablecoinId, symbol: "GAP", marketCapUsd: 2_400_000_000,
    currentPrice: null, currentSource: null, currentObservedAt: null, currentConfidence: null,
    rejectionReason: "missing", lastAcceptedPrice: null, lastAcceptedSource: null, lastAcceptedObservedAt: null,
    consecutiveMissingGenerations, alertEligible: true, ...extra,
  });
  it("names unacknowledged alert-eligible gaps past the critical band only", () => {
    const critical = STATUS_MISSING_PRICE_THRESHOLDS.generationsCritical;
    expect(getCriticalDurationActivePriceGapIds({
      missingActiveAssets: [
        gap("critical", critical), gap("elevated", critical - 1), gap("unknown", null),
        gap("not-eligible", critical, { alertEligible: false }), gap("acknowledged", critical),
      ],
      acknowledgedGapIds: ["acknowledged"],
    })).toEqual(["critical"]);
  });
});

describe("getBlacklistGapStatus", () => {
  it.each([
    [null, "degraded"],
    [0.005, "healthy"],
    [0.0099, "healthy"],
    [0.01, "degraded"],
    [0.0199, "degraded"],
    [0.02, "stale"],
  ] as const)("classifies a %s missing-amount share as %s", (missingRatio, status) => {
    expect(getBlacklistGapStatus({ missingRatio })).toBe(status);
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
