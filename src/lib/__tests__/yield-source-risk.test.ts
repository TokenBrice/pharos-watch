import { describe, expect, it } from "vitest";
import {
  classifyYieldSourceDepth,
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
