import { describe, it, expect } from "vitest";
import { emptyMintBurnClassificationTally, summarizeMintBurnClassification } from "@shared/lib/mint-burn-classification";
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

  it.each([
    ["moderate redemptions", -3e7, 0, 2e8, 1e8, -25, 1],
    ["moderate minting", 6e7, 0, 2e8, 1e8, 50, 1],
    ["clamped redemptions", -1e12, 0, 1e8, 1e12, -100, undefined],
    ["clamped minting", 1e12, 0, 1e8, 1e12, 100, undefined],
    ["denominator floor", -500_000, 0, 100, 500_000, -25, undefined],
    ["equal baseline", 5e7, 5e7, 3e8, 1e8, 0, undefined],
    ["nonzero baseline", -1e7, 5e7, 3e8, 1e8, -33.33, 0],
  ] as const)("computes intensity for %s", (_name, currentDailyNet, baselineDailyNet, baselineDailyAbs, currentDailyAbs, expected, precision) => {
    const result = computeFlowIntensity({ currentDailyNet, baselineDailyNet, baselineDailyAbs, currentDailyAbs, dataAgeDays: 30 });
    if (precision === undefined) expect(result).toBe(expected);
    else expect(result).toBeCloseTo(expected, precision);
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

  it("classifies finite out-of-range dust through the documented band table", () => {
    expect(getGaugeBand(-100.00000000000001)).toBe("CRISIS");
    expect(getGaugeBand(100.00000000000001)).toBe("SURGE");
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

  it("returns null for eligible intensities with zero total market cap", () => {
    expect(computeGaugeScore([{ intensity: 40, mcap: 0 }])).toBeNull();
  });

  it("is unavailable for empty or all-null inputs but observes a zero gauge for a positive weight", () => {
    expect(computeGaugeScore([])).toBeNull();
    expect(computeGaugeScore([{ intensity: null, mcap: 1e9 }])).toBeNull();
    expect(computeGaugeScore([{ intensity: 0, mcap: 1e9 }])).toBe(0);
  });

  it("keeps an all-floor cohort in the CRISIS band despite floating-point dust", () => {
    const score = computeGaugeScore([
      { intensity: -100, mcap: 81_342_260_539.53171 },
      { intensity: -100, mcap: 88_757_351_636.8866 },
    ]);
    expect(score).toBeGreaterThanOrEqual(-100);
    expect(score).toBeLessThanOrEqual(100);
    expect(getGaugeBand(score!)).toBe("CRISIS");
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

  it.each(["partial", "unknown"] as const)("withholds even an inactive FTQ verdict for %s classification", (state) => {
    const classification = summarizeMintBurnClassification({ ...emptyMintBurnClassificationTally(),
      unresolvedBurnEventCount: state === "partial" ? 1 : 0, unknownBurnHours: state === "unknown" ? 1 : 0 });
    const cohorts = { safe: [{ knownNetUsd: 0, valuation: complete, window24hComplete: true, classification }],
      risky: [{ knownNetUsd: 0, valuation: complete, window24hComplete: true }], unpublishedIds: [] };
    expect(detectFlightToQualityFromValuedNets(cohorts)).toBeNull();
    expect(getFlightToQualityUnavailableReason(cohorts)).toBe(classification.unavailableReason);
  });

  it("is exact when every classified coin has complete valuation", () => {
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: 300_000_000, valuation: complete }],
      risky: [{ knownNetUsd: -600_000_000, valuation: complete }],
    })).toMatchObject({ active: true, exact: true, safeNet24h: 300_000_000, riskyNet24h: -600_000_000 });
  });

  it("keeps a proven-inactive verdict when missing valuation cannot activate it", () => {
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: 500_000_000, valuation: complete }],
      risky: [{ knownNetUsd: -50_000_000, valuation: mintPartial }],
    })).toEqual({ active: false, intensity: 0, safeNet24h: 500_000_000, riskyNet24h: -50_000_000, exact: false });
  });

  it.each([null, 500_000_000])("returns unavailable for undecidable valuation or scope (%s)", (knownNetUsd) => {
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: 500_000_000, valuation: complete }],
      risky: [{ knownNetUsd: -50_000_000, valuation: burnPartial }],
    })).toBeNull();
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd, valuation: complete, window24hComplete: knownNetUsd === null ? undefined : false }],
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

  it.each([null, 250_000_000])("names an incomplete scan window instead of valuation (%s)", (knownNetUsd) => {
    expect(getFlightToQualityUnavailableReason({
      safe: [{ knownNetUsd, valuation: complete, window24hComplete: false }],
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
