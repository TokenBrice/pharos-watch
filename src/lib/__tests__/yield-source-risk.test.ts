import { describe, expect, it } from "vitest";
import {
  classifyYieldSourcePosture,
  classifyYieldSourceDepth,
  classifyYieldSourceFreshness,
  formatYieldSourceRiskSummary,
  formatYieldSourceRiskDriverSummary,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";
import {
  SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS,
  buildSourceRiskGoldenFixture,
  mergeSourceRiskGoldenFixtures,
} from "@shared/lib/__tests__/yield-source-risk-golden-fixtures";

describe("yield source risk UI helpers", () => {
  it("maps populated source-risk evidence to public driver labels", () => {
    const drivers = getYieldSourceRiskDrivers({
      sourceChanged: true,
      sourceRisk: mergeSourceRiskGoldenFixtures([
        "reward-heavy",
        "low-source-depth",
        "stale-source-age",
        "bootstrap-observation-count",
        "source-switch-churn",
      ]),
    });

    expect(drivers.map((driver) => driver.label)).toEqual(SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS);
    expect(formatYieldSourceRiskDriverSummary(drivers)).toContain("reward-heavy");
  });

  it("surfaces venue-risk and dependency-concentration drivers from populated evidence", () => {
    const high = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "high", venueRiskWeighted: 4.4 },
    });
    expect(high.map((driver) => driver.key)).toContain("high-risk-venue");
    expect(high[0]?.description).toContain("4.4/5");

    const concentrated = getYieldSourceRiskDrivers({
      sourceRisk: {
        venueRiskTier: "low",
        dependencyConcentration: {
          ecosystem: "Sky",
          severity: "medium",
          note: "Funded debt sits behind Sky governance.",
          reviewedAt: "2026-06-15",
        },
      },
    });
    expect(concentrated.map((driver) => driver.label)).toContain("Sky concentration");

    // Unknown/low venue with no concentration is a no-op.
    expect(getYieldSourceRiskDrivers({ sourceRisk: { venueRiskTier: "unknown" } })).toEqual([]);
  });

  it("classifies source posture from source-risk, warnings, and provenance evidence", () => {
    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1.05,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "low",
      },
      sourceTvlUsd: 10_000_000,
    })).toBe("clean");

    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1.15,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "unknown",
      },
      sourceTvlUsd: 10_000_000,
    })).toBe("watch");

    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "high",
      },
      sourceTvlUsd: 10_000_000,
    })).toBe("speculative");

    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "unknown",
      },
      sourceTvlUsd: 10_000_000,
      sourceChanged: true,
    })).toBe("watch");
  });

  it("uses source warning signals as posture drivers without treating unknown venue tier as high risk", () => {
    expect(classifyYieldSourcePosture({
      sourceRisk: { venueRiskTier: "unknown", sourceRiskPenalty: 1, sourceDepthRatio: 0.005, sourceAgeSeconds: 60 },
      sourceTvlUsd: 10_000_000,
      warningSignals: [],
    })).toBe("watch");

    expect(classifyYieldSourcePosture({
      sourceRisk: { venueRiskTier: "unknown", sourceRiskPenalty: 1, sourceDepthRatio: 0.005, sourceAgeSeconds: 60 },
      sourceTvlUsd: 10_000_000,
      warningSignals: ["reward-heavy"],
    })).toBe("speculative");

    expect(getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "unknown" },
      warningSignals: ["data-stale"],
    }).map((driver) => driver.key)).toEqual(["stale-source"]);
  });

  it("formats material source-risk summaries for compact row cells", () => {
    expect(formatYieldSourceRiskSummary({ sourceRiskScore: 42, sourceRiskPenalty: 1.32 })).toBe(
      "Source risk 42/100 | 1.32x",
    );
    expect(formatYieldSourceRiskSummary({ sourceRiskScore: 2, sourceRiskPenalty: 1.01 })).toBeNull();
  });

  it("flags low/partial venue-score confidence without discounting the penalty", () => {
    const low = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "high", venueRiskWeighted: 3.7, venueRiskConfidence: "low" },
    });
    expect(low[0]?.label).toContain("low confidence");
    expect(low[0]?.description).toContain("low-confidence");

    const partial = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "medium", venueRiskWeighted: 2.8, venueRiskConfidence: "partial" },
    });
    expect(partial[0]?.label).not.toContain("confidence"); // partial isn't shouted in the label
    expect(partial[0]?.description).toContain("partial-confidence");

    const verified = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "high", venueRiskWeighted: 4.4, venueRiskConfidence: "verified" },
    });
    expect(verified[0]?.label).toBe("high-risk venue");
    expect(verified[0]?.description).not.toContain("confidence");
  });

  it("keeps missing source-risk evidence neutral", () => {
    expect(getYieldSourceRiskDrivers({ sourceRisk: null })).toEqual([]);
    expect(getYieldSourceRiskDrivers({ sourceRisk: buildSourceRiskGoldenFixture("missing-safety") })).toEqual([]);
    expect(formatYieldSourceRiskDriverSummary([])).toContain("No populated source-risk driver");
  });

  it("classifies source depth only when TVL and supply-relative depth are present", () => {
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.02 }, sourceTvlUsd: 10_000_000 })).toBe("deep");
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.005 }, sourceTvlUsd: 10_000_000 })).toBe("moderate");
    expect(classifyYieldSourceDepth({
      sourceRisk: buildSourceRiskGoldenFixture("low-source-depth"),
      sourceTvlUsd: 10_000_000,
    })).toBe("thin");
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.02 }, sourceTvlUsd: null })).toBe("unknown");
    expect(classifyYieldSourceDepth({ sourceRisk: null, sourceTvlUsd: 10_000_000 })).toBe("unknown");
  });
});

describe("classifyYieldSourceFreshness", () => {
  it("returns null for null or undefined input", () => {
    expect(classifyYieldSourceFreshness(null)).toBeNull();
    expect(classifyYieldSourceFreshness(undefined)).toBeNull();
  });

  it("returns fresh tier for 0s", () => {
    const result = classifyYieldSourceFreshness(0);
    expect(result?.tier).toBe("fresh");
    expect(result?.relativeText).toBe("0s ago");
  });

  it("returns fresh tier for 1h", () => {
    const result = classifyYieldSourceFreshness(60 * 60);
    expect(result?.tier).toBe("fresh");
    expect(result?.relativeText).toBe("1h ago");
  });

  it("returns fresh tier at the 6h boundary", () => {
    const result = classifyYieldSourceFreshness(6 * 60 * 60);
    expect(result?.tier).toBe("fresh");
    expect(result?.relativeText).toBe("6h ago");
  });

  it("returns recent tier at the 12h boundary", () => {
    const result = classifyYieldSourceFreshness(12 * 60 * 60);
    expect(result?.tier).toBe("recent");
    expect(result?.relativeText).toBe("12h ago");
  });

  it("returns aging tier at the 24h boundary", () => {
    const result = classifyYieldSourceFreshness(24 * 60 * 60);
    expect(result?.tier).toBe("aging");
    expect(result?.relativeText).toBe("1d ago");
  });

  it("returns stale tier for 7d with days formatting", () => {
    const result = classifyYieldSourceFreshness(7 * 24 * 60 * 60);
    expect(result?.tier).toBe("stale");
    expect(result?.relativeText).toBe("7d ago");
  });

  it("clamps days formatting at >30d for 31d", () => {
    const result = classifyYieldSourceFreshness(31 * 24 * 60 * 60);
    expect(result?.tier).toBe("stale");
    expect(result?.relativeText).toBe(">30d ago");
  });

  it("returns null for NaN", () => {
    expect(classifyYieldSourceFreshness(Number.NaN)).toBeNull();
  });
});
