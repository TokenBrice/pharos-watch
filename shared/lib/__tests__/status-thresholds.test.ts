import { describe, expect, it } from "vitest";
import {
  getBlacklistGapStatus,
  isReserveDriftThresholdExceeded,
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

describe("isReserveDriftThresholdExceeded", () => {
  it("keeps the reserve drift watch threshold at greater than 15 points", () => {
    expect(STATUS_RESERVE_DRIFT_THRESHOLD_POINTS).toBe(15);
    expect(isReserveDriftThresholdExceeded(STATUS_RESERVE_DRIFT_THRESHOLD_POINTS)).toBe(false);
    expect(isReserveDriftThresholdExceeded(STATUS_RESERVE_DRIFT_THRESHOLD_POINTS + 0.1)).toBe(true);
  });
});
