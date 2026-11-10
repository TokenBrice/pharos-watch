import { describe, expect, it } from "vitest";
import {
  assessStablecoinChartContinuity,
  STABLECOIN_CHART_CONTINUITY_THRESHOLDS,
} from "../stablecoin-charts-continuity";
import type { StablecoinChartPoint } from "@shared/types/market";

const DAY = 86_400;
const NOW = 1_790_000_000;

function points(count: number, oldest: number, buckets: Record<string, number> = { peggedUSD: 100 }): StablecoinChartPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    date: oldest + index * DAY,
    totalCirculatingUSD: { ...buckets },
  }));
}

describe("stablecoin chart continuity", () => {
  it("accepts a publication that preserves point count, span and buckets", () => {
    const previous = points(60, NOW - 60 * DAY);
    const next = points(61, NOW - 60 * DAY);
    expect(assessStablecoinChartContinuity(previous, next)).toEqual([]);
  });

  it("flags a point-count collapse below the continuity share", () => {
    const previous = points(100, NOW - 100 * DAY);
    const next = points(
      Math.floor(100 * STABLECOIN_CHART_CONTINUITY_THRESHOLDS.minPointShare) - 1,
      NOW - 20 * DAY,
    );
    const findings = assessStablecoinChartContinuity(previous, next);
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["point-count-collapse", "history-start-truncated"]),
    );
  });

  it("flags a truncated history even when the point count stays above the share", () => {
    const previous = points(100, NOW - 900 * DAY);
    const next = points(100, NOW - 100 * DAY);
    expect(assessStablecoinChartContinuity(previous, next)).toContainEqual(
      expect.objectContaining({ code: "history-start-truncated" }),
    );
  });

  it("flags a missing currency bucket and a per-bucket value jump", () => {
    const previous = points(30, NOW - 30 * DAY, { peggedUSD: 100, peggedEUR: 50 });
    const next = points(30, NOW - 30 * DAY, { peggedUSD: 500 });
    next[next.length - 1].totalCirculatingUSD = { peggedUSD: 500 };
    const findings = assessStablecoinChartContinuity(previous, next);
    expect(findings).toContainEqual(expect.objectContaining({ code: "bucket-missing", bucket: "peggedEUR" }));
    expect(findings).toContainEqual(expect.objectContaining({ code: "bucket-value-drift", bucket: "peggedUSD" }));
  });

  it("treats an absent baseline as no finding but a truly empty candidate as a collapse", () => {
    expect(assessStablecoinChartContinuity([], points(10, NOW))).toEqual([]);
    expect(assessStablecoinChartContinuity(points(10, NOW), [])).toEqual([
      { code: "point-count-collapse", previous: 10, next: 0 },
    ]);
  });
});
