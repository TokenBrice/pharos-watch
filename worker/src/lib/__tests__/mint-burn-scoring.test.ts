import { describe, it, expect } from "vitest";
import {
  buildFlightToQualityCohorts,
  computeFlowIntensity,
  computeGaugeScore,
  detectFlightToQuality,
  detectFlightToQualityFromValuedNets,
  getFlightToQualityUnavailableReason,
  getGaugeBand,
  isGaugeBandRobustToWithheldWeight,
} from "../mint-burn-scoring";

describe("computeFlowIntensity", () => {

  it("computes correct value for moderate net redemptions", () => {
    // denominator = max(2e8 * 0.3, 1e6) = 6e7
    // z = (-3e7 - 0) / 6e7 = -0.5
    // intensity = clamp(-100, 100, -0.5 * 50) = -25
    const result = computeFlowIntensity({
      currentDailyNet: -3e7,
      baselineDailyNet: 0,
      baselineDailyAbs: 2e8,
      dataAgeDays: 30,
      currentDailyAbs: 100_000_000,
    });
    expect(result).toBeCloseTo(-25, 1);
  });

  it("computes correct value for moderate net minting", () => {
    // z = (6e7 - 0) / 6e7 = 1.0
    // intensity = clamp(-100, 100, 1.0 * 50) = 50
    const result = computeFlowIntensity({
      currentDailyNet: 6e7,
      baselineDailyNet: 0,
      baselineDailyAbs: 2e8,
      dataAgeDays: 30,
      currentDailyAbs: 100_000_000,
    });
    expect(result).toBeCloseTo(50, 1);
  });

  it("clamps to -100 for extreme net redemptions", () => {
    expect(
      computeFlowIntensity({
        currentDailyNet: -1e12,
        baselineDailyNet: 0,
        baselineDailyAbs: 1e8,
        dataAgeDays: 30,
        currentDailyAbs: 1_000_000_000_000,
      })
    ).toBe(-100);
  });

  it("clamps to 100 for extreme net minting", () => {
    expect(
      computeFlowIntensity({
        currentDailyNet: 1e12,
        baselineDailyNet: 0,
        baselineDailyAbs: 1e8,
        dataAgeDays: 30,
        currentDailyAbs: 1_000_000_000_000,
      })
    ).toBe(100);
  });

  it("uses floor of 1M for denominator when baseline abs flow is tiny", () => {
    // absBaseline = 100, denom = max(100 * 0.3, 1e6) = 1e6
    // z = -500000 / 1e6 = -0.5, below saturation.
    const result = computeFlowIntensity({
      currentDailyNet: -500_000,
      baselineDailyNet: 0,
      baselineDailyAbs: 100,
      dataAgeDays: 30,
      currentDailyAbs: 500_000,
    });
    expect(result).toBe(-25);
  });

  it("accounts for non-zero baseline in z-score", () => {
    expect(
      computeFlowIntensity({
        currentDailyNet: 5e7,
        baselineDailyNet: 5e7,
        baselineDailyAbs: 3e8,
        dataAgeDays: 30,
        currentDailyAbs: 100_000_000,
      })
    ).toBe(0);

    // current = -1e7 (slight redemptions vs normal $50M minting)
    // z = (-1e7 - 5e7) / 9e7 = -6e7 / 9e7 = -0.667
    // intensity = clamp(-100, 100, -0.667 * 50) = -33.33
    expect(
      computeFlowIntensity({
        currentDailyNet: -1e7,
        baselineDailyNet: 5e7,
        baselineDailyAbs: 3e8,
        dataAgeDays: 30,
        currentDailyAbs: 100_000_000,
      })
    ).toBeCloseTo(-33.33, 0);
  });

  it("includes exactly seven days and $50K activity, but excludes either just below", () => {
    const input = { currentDailyNet: 50_000, baselineDailyNet: 0, baselineDailyAbs: 100, dataAgeDays: 7, currentDailyAbs: 50_000 };
    expect(computeFlowIntensity(input)).toBe(2.5);
    expect(computeFlowIntensity({ ...input, dataAgeDays: 6.999 })).toBeNull();
    expect(computeFlowIntensity({ ...input, currentDailyAbs: 49_999 })).toBeNull();
  });
});

describe("getGaugeBand", () => {

  it("pins inclusive lower-bound gauge assignments", () => {
    expect(getGaugeBand(-100)).toBe("CRISIS");
    expect(getGaugeBand(-70)).toBe("STRESS");
    expect(getGaugeBand(-40)).toBe("CAUTIOUS");
    expect(getGaugeBand(-10)).toBe("NEUTRAL");
    expect(getGaugeBand(10)).toBe("HEALTHY");
    expect(getGaugeBand(40)).toBe("CONFIDENT");
    expect(getGaugeBand(70)).toBe("SURGE");
    expect(getGaugeBand(100)).toBe("SURGE");
  });

  it("pins exclusive upper-bound gauge assignments", () => {
    expect(getGaugeBand(-70.000001)).toBe("CRISIS");
    expect(getGaugeBand(-40.000001)).toBe("STRESS");
    expect(getGaugeBand(-10.000001)).toBe("CAUTIOUS");
    expect(getGaugeBand(9.999999)).toBe("NEUTRAL");
    expect(getGaugeBand(39.999999)).toBe("HEALTHY");
    expect(getGaugeBand(69.999999)).toBe("CONFIDENT");
  });
});

describe("computeGaugeScore", () => {

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

  it("returns null for eligible intensities with zero total market cap", () => {
    expect(computeGaugeScore([{ intensity: 40, mcap: 0 }])).toBeNull();
  });

  it("is unavailable for empty or all-null inputs but observes a zero gauge for a positive weight", () => {
    expect(computeGaugeScore([])).toBeNull();
    expect(computeGaugeScore([{ intensity: null, mcap: 1e9 }])).toBeNull();
    expect(computeGaugeScore([{ intensity: 0, mcap: 1e9 }])).toBe(0);
  });

  it("counts only valid intensities that carry a positive admitted weight", () => {
    expect(computeGaugeScore([
      { intensity: 80, mcap: 0 },
      { intensity: 20, mcap: 1e9 },
      { intensity: null, mcap: 5e9 },
    ])).toBe(20);
  });
});

describe("isGaugeBandRobustToWithheldWeight", () => {
  // Score 37.5 (HEALTHY, [10, 40)): withheld weight w beside scored weight W can lift the
  // full-cohort score to (37.5W + 100w)/(W + w), which reaches the 40 edge exactly at w = W/24.
  it.each([
    ["just below the band edge", 25, 1, true],
    ["exactly at the band edge", 24, 1, false],
    ["no withheld weight", 1, 0, true],
    ["nothing scored", 0, 1, false],
  ])("%s", (_label, scoredMcapUsd, withheldMcapUsd, robust) => {
    expect(isGaugeBandRobustToWithheldWeight({ score: 37.5, scoredMcapUsd, withheldMcapUsd })).toBe(robust);
  });

  it("checks the downward edge and stays in range at the score bounds", () => {
    // Down: (12W − 100w)/(W + w) reaches 10 at w = 2W/110.
    expect(isGaugeBandRobustToWithheldWeight({ score: 12, scoredMcapUsd: 110, withheldMcapUsd: 1.9 })).toBe(true);
    expect(isGaugeBandRobustToWithheldWeight({ score: 12, scoredMcapUsd: 110, withheldMcapUsd: 2.1 })).toBe(false);
    expect(isGaugeBandRobustToWithheldWeight({ score: -100, scoredMcapUsd: 3e11, withheldMcapUsd: 1 })).toBe(true);
  });
});

describe("detectFlightToQuality", () => {

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

  it("requires both flows to strictly exceed $100M", () => {
    expect(detectFlightToQuality({ safeNet24h: 1e8, riskyNet24h: -2e8 })).toEqual({ active: false, intensity: 0 });
    expect(detectFlightToQuality({ safeNet24h: 2e8, riskyNet24h: -1e8 })).toEqual({ active: false, intensity: 0 });
  });
});

describe("detectFlightToQualityFromValuedNets", () => {
  const complete = { mintCompleteness: "complete", burnCompleteness: "complete" } as const;
  const burnPartial = { mintCompleteness: "complete", burnCompleteness: "partial" } as const;
  const mintPartial = { mintCompleteness: "partial", burnCompleteness: "complete" } as const;

  it("is exact when every classified coin has complete valuation", () => {
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: 300_000_000, valuation: complete }],
      risky: [{ knownNetUsd: -600_000_000, valuation: complete }],
    })).toMatchObject({ active: true, exact: true, safeNet24h: 300_000_000, riskyNet24h: -600_000_000 });
  });

  it("keeps a proven-inactive verdict when missing valuation cannot activate it", () => {
    // Risky mints are unbounded upward only; burns are complete, so the risky net cannot fall below -$50M.
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: 500_000_000, valuation: complete }],
      risky: [{ knownNetUsd: -50_000_000, valuation: mintPartial }],
    })).toEqual({ active: false, intensity: 0, safeNet24h: 500_000_000, riskyNet24h: -50_000_000, exact: false });
  });

  it("returns unavailable when missing valuation could change the verdict", () => {
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: 500_000_000, valuation: complete }],
      risky: [{ knownNetUsd: -50_000_000, valuation: burnPartial }],
    })).toBeNull();
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: null, valuation: complete }],
      risky: [{ knownNetUsd: -600_000_000, valuation: complete }],
    })).toBeNull();
  });
});

describe("buildFlightToQualityCohorts", () => {
  const complete = { mintCompleteness: "complete", burnCompleteness: "complete" } as const;
  const flows = new Map([
    ["usdc-circle", { knownNetUsd: 250_000_000, valuation: complete, window24hComplete: true }],
    ["dai-makerdao", { knownNetUsd: -150_000_000, valuation: complete, window24hComplete: true }],
  ]);
  const classification = {
    safeIds: new Set(["usdc-circle"]),
    riskyIds: new Set(["dai-makerdao", "swanusd-swan"]),
  };
  // swanUSD's only configured leg has no durable admission proof, so its flow is
  // outside the published scope: disclosed and excluded, never carried as a zero.
  const pendingAdmission = {
    legs: [
      { stablecoinId: "usdc-circle", status: "admitted" as const },
      { stablecoinId: "swanusd-swan", status: "pending-admission" as const },
    ],
  };

  it("excludes a classified coin pending admission, discloses it, and keeps the verdict", () => {
    const cohorts = buildFlightToQualityCohorts(classification, flows, pendingAdmission);
    expect(cohorts.risky.map((coin) => coin.knownNetUsd)).toEqual([-150_000_000]);
    expect(cohorts.excludedIds).toEqual(["swanusd-swan"]);
    expect(cohorts.unpublishedIds).toEqual([]);
    // The observed nets are decisive again: safe +$250M against risky -$150M.
    expect(detectFlightToQualityFromValuedNets(cohorts)).toMatchObject({
      active: true, intensity: 15, safeNet24h: 250_000_000, riskyNet24h: -150_000_000, exact: true,
    });
  });

  it("keeps a classified coin with no published flow and no pending leg unbounded", () => {
    const cohorts = buildFlightToQualityCohorts(classification, flows, null);
    expect(cohorts.excludedIds).toEqual([]);
    expect(cohorts.unpublishedIds).toEqual(["swanusd-swan"]);
    expect(detectFlightToQualityFromValuedNets(cohorts)).toBeNull();
  });

  it("excludes only pending admission, keeping a kill-switched coin unbounded", () => {
    const cohorts = buildFlightToQualityCohorts(classification, flows, {
      legs: [{ stablecoinId: "swanusd-swan", status: "disabled" as const }],
    });
    expect(cohorts.excludedIds).toEqual([]);
    expect(cohorts.unpublishedIds).toEqual(["swanusd-swan"]);
    expect(detectFlightToQualityFromValuedNets(cohorts)).toBeNull();
    expect(getFlightToQualityUnavailableReason(cohorts)).toBe("cohort-member-unpublished");
  });
});

describe("getFlightToQualityUnavailableReason", () => {
  const complete = { mintCompleteness: "complete", burnCompleteness: "complete" } as const;

  it("names an incomplete scan window instead of valuation", () => {
    expect(getFlightToQualityUnavailableReason({
      safe: [{ knownNetUsd: null, valuation: complete, window24hComplete: false }],
      risky: [{ knownNetUsd: -150_000_000, valuation: complete, window24hComplete: true }],
      unpublishedIds: [],
    })).toBe("flow-window-unavailable");
  });

  it("names a classified coin with no published flow", () => {
    expect(getFlightToQualityUnavailableReason({
      safe: [{ knownNetUsd: 250_000_000, valuation: complete, window24hComplete: true }],
      risky: [{ knownNetUsd: null, valuation: complete, window24hComplete: null }],
      unpublishedIds: ["swanusd-swan"],
    })).toBe("cohort-member-unpublished");
  });

  it("keeps valuation as the cause when every cohort member is published", () => {
    expect(getFlightToQualityUnavailableReason({
      safe: [{ knownNetUsd: 250_000_000, valuation: { mintCompleteness: "partial", burnCompleteness: "complete" }, window24hComplete: true }],
      risky: [{ knownNetUsd: -150_000_000, valuation: complete, window24hComplete: true }],
      unpublishedIds: [],
    })).toBe("valuation-incomplete");
  });
});
