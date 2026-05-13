import { describe, expect, it } from "vitest";
import {
  classifyYieldSourceDepth,
  formatYieldSourceRiskDriverSummary,
  getYieldSourceRiskDrivers,
} from "@/lib/yield-source-risk";

describe("yield source risk UI helpers", () => {
  it("maps populated source-risk evidence to public driver labels", () => {
    const drivers = getYieldSourceRiskDrivers({
      sourceChanged: true,
      sourceRisk: {
        rewardShare: 0.8,
        sourceDepthRatio: 0.0005,
        sourceAgeSeconds: 7 * 60 * 60,
        observationCount30d: 3,
        sourceSwitchCount30d: 1,
      },
    });

    expect(drivers.map((driver) => driver.label)).toEqual([
      "reward-heavy",
      "thin source depth",
      "stale source",
      "limited history",
      "source changed",
    ]);
    expect(formatYieldSourceRiskDriverSummary(drivers)).toContain("reward-heavy");
  });

  it("keeps missing source-risk evidence neutral", () => {
    expect(getYieldSourceRiskDrivers({ sourceRisk: null })).toEqual([]);
    expect(formatYieldSourceRiskDriverSummary([])).toContain("No populated source-risk driver");
  });

  it("classifies source depth only when TVL and supply-relative depth are present", () => {
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.02 }, sourceTvlUsd: 10_000_000 })).toBe("deep");
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.005 }, sourceTvlUsd: 10_000_000 })).toBe("moderate");
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.0005 }, sourceTvlUsd: 10_000_000 })).toBe("thin");
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.02 }, sourceTvlUsd: null })).toBe("unknown");
    expect(classifyYieldSourceDepth({ sourceRisk: null, sourceTvlUsd: 10_000_000 })).toBe("unknown");
  });
});
