import { describe, expect, it } from "vitest";
import { getBlacklistGapStatus } from "../status-thresholds";

describe("getBlacklistGapStatus", () => {
  it("returns healthy for historical low-ratio blacklist gaps", () => {
    expect(getBlacklistGapStatus({
      missingRatio: 0.005,
      recentMissingAmounts: 0,
    })).toBe("healthy");
  });

  it("returns degraded when recent blacklist gaps exist", () => {
    expect(getBlacklistGapStatus({
      missingRatio: 0.005,
      recentMissingAmounts: 1,
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
