import { describe, it, expect } from "vitest";
import {
  computeFlowIntensity,
  computeGaugeScore,
  detectFlightToQuality,
  getGaugeBand,
} from "../mint-burn-scoring";

describe("computeFlowIntensity", () => {
  it("returns null when fewer than 7 days of data", () => {
    expect(
      computeFlowIntensity({
        currentDailyNet: -1e8,
        baselineDailyNet: 0,
        baselineDailyAbs: 1e9,
        dataAgeDays: 5,
      })
    ).toBeNull();
  });

  it("returns exactly 50 when current equals baseline (neutral)", () => {
    const result = computeFlowIntensity({
      currentDailyNet: 1e8,
      baselineDailyNet: 1e8,
      baselineDailyAbs: 5e8,
      dataAgeDays: 30,
    });
    expect(result).toBe(50);
  });

  it("computes correct value for moderate net redemptions", () => {
    // denominator = max(2e8 * 0.3, 1e6) = 6e7
    // z = (-3e7 - 0) / 6e7 = -0.5
    // intensity = 50 + (-0.5 * 25) = 37.5
    const result = computeFlowIntensity({
      currentDailyNet: -3e7,
      baselineDailyNet: 0,
      baselineDailyAbs: 2e8,
      dataAgeDays: 30,
    });
    expect(result).toBeCloseTo(37.5, 1);
  });

  it("computes correct value for moderate net minting", () => {
    // z = (6e7 - 0) / 6e7 = 1.0
    // intensity = 50 + 1.0 * 25 = 75
    const result = computeFlowIntensity({
      currentDailyNet: 6e7,
      baselineDailyNet: 0,
      baselineDailyAbs: 2e8,
      dataAgeDays: 30,
    });
    expect(result).toBeCloseTo(75, 1);
  });

  it("clamps to 0 for extreme net redemptions", () => {
    expect(
      computeFlowIntensity({
        currentDailyNet: -1e12,
        baselineDailyNet: 0,
        baselineDailyAbs: 1e8,
        dataAgeDays: 30,
      })
    ).toBe(0);
  });

  it("clamps to 100 for extreme net minting", () => {
    expect(
      computeFlowIntensity({
        currentDailyNet: 1e12,
        baselineDailyNet: 0,
        baselineDailyAbs: 1e8,
        dataAgeDays: 30,
      })
    ).toBe(100);
  });

  it("uses floor of 1M for denominator when baseline abs flow is tiny", () => {
    // absBaseline = 100, denom = max(100 * 0.3, 1e6) = 1e6
    // z = (-2e6 - 0) / 1e6 = -2.0
    // intensity = 50 + (-2 * 25) = 0
    const result = computeFlowIntensity({
      currentDailyNet: -2e6,
      baselineDailyNet: 0,
      baselineDailyAbs: 100,
      dataAgeDays: 30,
    });
    expect(result).toBeCloseTo(0, 1);
  });

  it("accounts for non-zero baseline in z-score", () => {
    expect(
      computeFlowIntensity({
        currentDailyNet: 5e7,
        baselineDailyNet: 5e7,
        baselineDailyAbs: 3e8,
        dataAgeDays: 30,
      })
    ).toBe(50);

    // current = -1e7 (slight redemptions vs normal $50M minting)
    // z = (-1e7 - 5e7) / 9e7 = -6e7 / 9e7 = -0.667
    // intensity = 50 + (-0.667 * 25) = 50 - 16.67 = 33.33
    expect(
      computeFlowIntensity({
        currentDailyNet: -1e7,
        baselineDailyNet: 5e7,
        baselineDailyAbs: 3e8,
        dataAgeDays: 30,
      })
    ).toBeCloseTo(33.33, 0);
  });
});

describe("getGaugeBand", () => {
  it("returns CRISIS for 0-15", () => {
    expect(getGaugeBand(10)).toEqual({ label: "CRISIS", color: "red" });
  });
  it("returns NEUTRAL for 45-55", () => {
    expect(getGaugeBand(50)).toEqual({ label: "NEUTRAL", color: "gray" });
  });
  it("returns SURGE for 85-100", () => {
    expect(getGaugeBand(95)).toEqual({ label: "SURGE", color: "bright-green" });
  });
});

describe("computeGaugeScore", () => {
  it("ignores coins with null intensity in weighted average", () => {
    // Only the coin with intensity=40 is included; the null coin is skipped
    expect(
      computeGaugeScore([
        { intensity: 40, mcap: 1e11 },
        { intensity: null, mcap: 5e10 },
      ])
    ).toBe(40);
  });

  it("computes mcap-weighted average", () => {
    // 60 * (100B/150B) + 40 * (50B/150B) = 40 + 13.33 = 53.33
    const result = computeGaugeScore([
      { intensity: 60, mcap: 1e11 },
      { intensity: 40, mcap: 5e10 },
    ]);
    expect(result).toBeCloseTo(53.33, 1);
  });

  it("skips coins with null intensity and computes from available data", () => {
    const result = computeGaugeScore([
      { intensity: 60, mcap: 1e11 },
      { intensity: null, mcap: 5e10 },
      { intensity: 40, mcap: 5e10 },
    ]);
    // 60 * (100B/150B) + 40 * (50B/150B) = 40 + 13.33 = 53.33
    expect(result).toBeCloseTo(53.33, 1);
  });

  it("returns null when ALL coins have null intensity", () => {
    expect(
      computeGaugeScore([
        { intensity: null, mcap: 1e11 },
        { intensity: null, mcap: 5e10 },
      ])
    ).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeGaugeScore([])).toBeNull();
  });
});

describe("detectFlightToQuality", () => {
  it("returns inactive when risky outflows below $100M threshold", () => {
    expect(
      detectFlightToQuality({ safeNet24h: 2e8, riskyNet24h: -5e7 })
    ).toEqual({
      active: false,
      intensity: 0,
    });
  });

  it("returns inactive when safe inflows below $100M threshold", () => {
    expect(
      detectFlightToQuality({ safeNet24h: 5e7, riskyNet24h: -2e8 })
    ).toEqual({
      active: false,
      intensity: 0,
    });
  });

  it("computes exact intensity when both thresholds exceeded", () => {
    // intensity = min(100, abs(-2e8) / 1e9 * 100) = min(100, 20) = 20
    const result = detectFlightToQuality({
      safeNet24h: 3e8,
      riskyNet24h: -2e8,
    });
    expect(result).toEqual({ active: true, intensity: 20 });
  });

  it("caps intensity at 100 for extreme outflows", () => {
    const result = detectFlightToQuality({
      safeNet24h: 5e9,
      riskyNet24h: -2e9,
    });
    expect(result).toEqual({ active: true, intensity: 100 });
  });
});
