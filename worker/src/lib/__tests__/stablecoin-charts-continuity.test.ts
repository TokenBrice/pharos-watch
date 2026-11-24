import { describe, expect, it } from "vitest";
import {
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
} from "@shared/lib/stablecoins/aggregate-universe";
import {
  assessStablecoinChartContinuityWithCutover,
  parseStablecoinChartsPerimeterRecord,
  STABLECOIN_CHART_CONTINUITY_THRESHOLDS,
} from "../stablecoin-charts-continuity";
import type { StablecoinChartPoint } from "@shared/types/supply";

const DAY = 86_400;
const NOW = 1_790_000_000;
const assess = (previous: readonly StablecoinChartPoint[], next: readonly StablecoinChartPoint[]) =>
  assessStablecoinChartContinuityWithCutover(previous, next).blockingFindings;

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
    expect(assess(previous, next)).toEqual([]);
  });

  it("flags a point-count collapse below the continuity share", () => {
    const previous = points(100, NOW - 100 * DAY);
    const next = points(
      Math.floor(100 * STABLECOIN_CHART_CONTINUITY_THRESHOLDS.minPointShare) - 1,
      NOW - 20 * DAY,
    );
    const findings = assess(previous, next);
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["point-count-collapse", "history-start-truncated"]),
    );
  });

  it("flags a truncated history even when the point count stays above the share", () => {
    const previous = points(100, NOW - 900 * DAY);
    const next = points(100, NOW - 100 * DAY);
    expect(assess(previous, next)).toContainEqual(
      expect.objectContaining({ code: "history-start-truncated" }),
    );
  });

  it("flags a missing currency bucket and a per-bucket value jump", () => {
    const previous = points(30, NOW - 30 * DAY, { peggedUSD: 100, peggedEUR: 50 });
    const next = points(30, NOW - 30 * DAY, { peggedUSD: 500 });
    next[next.length - 1].totalCirculatingUSD = { peggedUSD: 500 };
    const findings = assess(previous, next);
    expect(findings).toContainEqual(expect.objectContaining({ code: "bucket-missing", bucket: "peggedEUR" }));
    expect(findings).toContainEqual(expect.objectContaining({ code: "bucket-value-drift", bucket: "peggedUSD" }));
  });

  it("treats an absent baseline as no finding but a truly empty candidate as a collapse", () => {
    expect(assess([], points(10, NOW))).toEqual([]);
    expect(assess(points(10, NOW), [])).toEqual([
      { code: "point-count-collapse", previous: 10, next: 0 },
    ]);
  });

  it("accepts non-USD drift only on forward v1 -> v2 cutover and blocks v2 -> v1, peggedUSD drift, truncation, and invalid values", () => {
    const previous = points(60, NOW - 60 * DAY, { peggedUSD: 250, peggedEUR: 100, peggedGBP: 50, peggedCHF: 10 });
    const next = points(61, NOW - 60 * DAY, { peggedUSD: 240, peggedEUR: 23, peggedGBP: 14 });
    // EUR -77%, GBP -72%, CHF removed: accepted once across forward v1 -> v2 cutover.
    const cutover = assessStablecoinChartContinuityWithCutover(previous, next, {
      previousUniverse: "core-stablecoins-v1",
      nextUniverse: "core-stablecoins-v2",
    });
    expect(cutover.blockingFindings).toEqual([]);
    expect(cutover.acceptedCutoverFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "bucket-value-drift", bucket: "peggedEUR" }),
      expect.objectContaining({ code: "bucket-value-drift", bucket: "peggedGBP" }),
      expect.objectContaining({ code: "bucket-missing", bucket: "peggedCHF" }),
    ]));

    // Same universe (next run after cutover): identical drift blocks.
    const sameUniverse = assessStablecoinChartContinuityWithCutover(previous, next, {
      previousUniverse: "core-stablecoins-v2",
      nextUniverse: "core-stablecoins-v2",
    });
    expect(sameUniverse.acceptedCutoverFindings).toEqual([]);
    expect(sameUniverse.blockingFindings.map((f) => f.bucket)).toEqual(
      expect.arrayContaining(["peggedEUR", "peggedGBP", "peggedCHF"]),
    );

    // Backward v2 -> v1 regression blocks unconditionally (with or without bucket drift).
    const reverseCalm = assessStablecoinChartContinuityWithCutover(previous, points(61, NOW - 60 * DAY, { peggedUSD: 250, peggedEUR: 100, peggedGBP: 50, peggedCHF: 10 }), {
      previousUniverse: "core-stablecoins-v2",
      nextUniverse: "core-stablecoins-v1",
    });
    expect(reverseCalm.acceptedCutoverFindings).toEqual([]);
    expect(reverseCalm.blockingFindings).toContainEqual({
      code: "perimeter-universe-regression",
      previous: 2,
      next: 1,
    });
    const reverseDrift = assessStablecoinChartContinuityWithCutover(previous, next, {
      previousUniverse: "core-stablecoins-v2",
      nextUniverse: "core-stablecoins-v1",
    });
    expect(reverseDrift.acceptedCutoverFindings).toEqual([]);
    expect(reverseDrift.blockingFindings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["perimeter-universe-regression", "bucket-value-drift", "bucket-missing"]),
    );

    // peggedUSD value drift stays fail-closed even on the forward v1 -> v2 cutover.
    const usdCollapse = assessStablecoinChartContinuityWithCutover(
      previous,
      points(61, NOW - 60 * DAY, { peggedUSD: 50, peggedEUR: 23, peggedGBP: 14 }),
      { previousUniverse: "core-stablecoins-v1", nextUniverse: "core-stablecoins-v2" },
    );
    expect(usdCollapse.blockingFindings).toEqual([
      { code: "bucket-value-drift", previous: 250, next: 50, bucket: "peggedUSD" },
    ]);
    expect(usdCollapse.acceptedCutoverFindings.map((f) => f.bucket)).toEqual(
      expect.arrayContaining(["peggedEUR", "peggedGBP", "peggedCHF"]),
    );

    // Truncation, negative values, and peggedUSD disappearance remain blocking even on cutover.
    const truncated = points(20, NOW - 20 * DAY, { peggedEUR: -5 });
    const badCutover = assessStablecoinChartContinuityWithCutover(previous, truncated, {
      previousUniverse: "core-stablecoins-v1",
      nextUniverse: "core-stablecoins-v2",
    });
    expect(badCutover.blockingFindings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["point-count-collapse", "bucket-missing", "bucket-value-drift"]),
    );
    expect(badCutover.blockingFindings).toContainEqual(
      expect.objectContaining({ code: "bucket-missing", bucket: "peggedUSD" }),
    );
  });

  it("parses valid perimeter cache records and rejects malformed or non-forward acceptedFromUniverse", () => {
    expect(parseStablecoinChartsPerimeterRecord(JSON.stringify({
      universe: "core-stablecoins-v2",
      cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
      acceptedFromUniverse: "core-stablecoins-v1",
      acceptedAt: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
    }))).toEqual({
      universe: "core-stablecoins-v2",
      cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
      acceptedFromUniverse: "core-stablecoins-v1",
      acceptedAt: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
    });
    expect(parseStablecoinChartsPerimeterRecord("{bad-json")).toBeNull();
    expect(parseStablecoinChartsPerimeterRecord(JSON.stringify({ universe: "unknown", cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE }))).toBeNull();
    expect(parseStablecoinChartsPerimeterRecord(JSON.stringify({ universe: "core-stablecoins-v2", cutoverDate: "not-a-date" }))).toBeNull();
    expect(parseStablecoinChartsPerimeterRecord(JSON.stringify({ universe: "core-stablecoins-v2", cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE, acceptedFromUniverse: "unknown" }))).toBeNull();
    expect(parseStablecoinChartsPerimeterRecord(JSON.stringify({ universe: "core-stablecoins-v2", cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE, acceptedFromUniverse: "core-stablecoins-v2" }))).toBeNull();
    expect(parseStablecoinChartsPerimeterRecord(JSON.stringify({ universe: "core-stablecoins-v1", cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE, acceptedFromUniverse: "core-stablecoins-v2" }))).toBeNull();
  });
});
