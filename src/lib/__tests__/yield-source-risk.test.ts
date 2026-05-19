import { describe, expect, it } from "vitest";
import {
  classifyYieldSourceDepth,
  classifyYieldSourceFreshness,
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
