// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { YieldHistoryPoint } from "@shared/types";
import {
  PRESET_DAYS,
  deriveYieldSourceSegments,
  getYieldHistorySourceDisplayLabel,
  useYieldHistoryChartModel,
} from "@/components/yield-history-chart-model";
import { YIELD_HISTORY_MAX_DAYS } from "@shared/lib/yield-history-policy";

const historyBySource = new Map<string, YieldHistoryPoint[]>();
vi.mock("@/hooks/api-hooks", () => ({
  useYieldHistory: (_id: string, options: { sourceKey: string | null; enabled?: boolean }) => ({
    data: { history: options.enabled === false ? [] : historyBySource.get(options.sourceKey ?? "best") ?? [] },
  }),
}));
afterEach(() => {
  cleanup();
  historyBySource.clear();
});

const BASE = Date.UTC(2026, 0, 1);
function point(date: number, apy: number, overrides: Partial<YieldHistoryPoint> = {}): YieldHistoryPoint {
  return { date, apy, apyBase: null, apyReward: null, exchangeRate: null,
    sourceTvlUsd: null, warningSignals: [], ...overrides };
}
const chartProps = { stablecoinId: "fixture", benchmarkRate: 5, medianApy: 5 };

describe("yield history transformations", () => {
  it("prioritizes overlays, caps the cohort at four, and drops stale internal selection", () => {
    const sources = ["a", "b", "c", "d", "e"].map((sourceKey) => ({ sourceKey, yieldSource: sourceKey }));
    for (const [index, source] of sources.entries()) historyBySource.set(source.sourceKey, [point(BASE, index + 5)]);
    const { result, rerender } = renderHook(
      ({ availableSources, externalSourceKeys }: { availableSources: typeof sources; externalSourceKeys?: string[] }) =>
        useYieldHistoryChartModel({ ...chartProps, availableSources, externalSourceKeys }),
      { initialProps: { availableSources: sources, externalSourceKeys: undefined as string[] | undefined } },
    );
    act(() => result.current.onSourceChange?.("b"));
    expect(result.current.chartData[0].apy).toBe(6);
    rerender({ availableSources: sources, externalSourceKeys: ["a", "b", "c", "d", "e"] });
    expect(result.current.selectedSourceKey).toBe("b");
    expect(result.current.primarySourceKey).toBe("a");
    expect(result.current.mergedChartData[0]).toMatchObject({ apy: 5, apy_overlay_0: 6, apy_overlay_1: 7, apy_overlay_2: 8 });
    expect(result.current.overlaySeriesKeys).toEqual(["apy_overlay_0", "apy_overlay_1", "apy_overlay_2"]);
    historyBySource.set("best", [point(BASE, 3)]);
    rerender({ availableSources: sources.filter((source) => source.sourceKey !== "b"), externalSourceKeys: undefined });
    expect(result.current.selectedSourceKey).toBe("best");
    expect(result.current.primarySourceKey).toBe("best");
    expect(result.current.chartData[0].apy).toBe(3);
  });

  it("aligns seconds and milliseconds by hour without turning missing observations into zero", () => {
    historyBySource.set("a", [point(BASE / 1000 + 10, 5), point(BASE + 3_600_000 + 10_000, 6), point(BASE + 7_200_000 + 10_000, 7)]);
    historyBySource.set("b", [point(BASE + 300_000, 8.5), point(BASE / 1000 + 3600 + 300, 9.5)]);
    const { result } = renderHook(() => useYieldHistoryChartModel({ ...chartProps, externalSourceKeys: ["a", "b"] }));
    expect(result.current.mergedChartData.map(({ date, apy_overlay_0 }) => [date, apy_overlay_0]))
      .toEqual([[BASE + 10_000, 8.5], [BASE + 3_610_000, 9.5], [BASE + 7_210_000, null]]);
  });

  it("uses the trailing thirty-day window and includes equality at the spike ratio threshold", () => {
    historyBySource.set("best", [
      point(BASE, 0.5),
      ...[31, 32, 33].map((day) => point(BASE + day * 86_400_000, 4)),
      point(BASE + 34 * 86_400_000, 8),
    ]);
    const { result, rerender } = renderHook(() => useYieldHistoryChartModel(chartProps));
    expect(result.current.spikeAnnotations).toEqual([{ date: BASE + 34 * 86_400_000, apy: 8, trailingAvg: 4, ratio: 2 }]);
    historyBySource.set("best", [
      ...[0, 1, 2].map((day) => point(BASE + day * 86_400_000, 0.5)),
      point(BASE + 3 * 86_400_000, 2),
      point(BASE + 4 * 86_400_000, 2.01),
    ]);
    rerender();
    expect(result.current.spikeAnnotations.map(({ date, apy }) => [date, apy]))
      .toEqual([[BASE + 4 * 86_400_000, 2.01]]);
  });

  it("includes overlays and only enabled breakdown values in the plotted domain", () => {
    historyBySource.set("a", [point(BASE, 5, { apyBase: 1, apyReward: 2 })]);
    historyBySource.set("b", [point(BASE, 9)]);
    const { result } = renderHook(() => useYieldHistoryChartModel({ ...chartProps, externalSourceKeys: ["a", "b"] }));
    expect(result.current.yDomain).toEqual([4.5, 9.5]);
    act(() => result.current.setShowBreakdown(true));
    expect(result.current.effectiveShowBreakdown).toBe(true);
    expect(result.current.yDomain[0]).toBeCloseTo(0.36);
    expect(result.current.yDomain[1]).toBeCloseTo(9.64);
  });

  it("does not flatten a narrow data range to include a distant benchmark", () => {
    historyBySource.set("best", [point(BASE, 3.5), point(BASE + 86_400_000, 3.5)]);
    const { result } = renderHook(() => useYieldHistoryChartModel({ ...chartProps, benchmarkRate: -0.04, medianApy: 3.5 }));
    expect(result.current.yDomain).toEqual([3, 4]);
  });
});
it("uses the shared public history window for the longest chart preset", () => {
  expect(PRESET_DAYS.at(-1)).toBe(YIELD_HISTORY_MAX_DAYS);
});

describe("yield history chart source display", () => {
  it("disambiguates duplicate source names with source identity", () => {
    const sources = [
      { sourceKey: "aave-v3:ethereum:usdc", yieldSource: "Aave V3" },
      { sourceKey: "aave-v3:base:usdc", yieldSource: "Aave V3" },
      { sourceKey: "compound-v3:base:usdc", yieldSource: "Compound V3" },
    ];

    expect(getYieldHistorySourceDisplayLabel(sources[0], sources)).toBe("Aave V3 (...thereum:usdc)");
    expect(getYieldHistorySourceDisplayLabel(sources[1], sources)).toBe("Aave V3 (...v3:base:usdc)");
    expect(getYieldHistorySourceDisplayLabel(sources[2], sources)).toBe("Compound V3");
  });
});

describe("deriveYieldSourceSegments", () => {
  it("returns a single segment spanning the full range when one source is present", () => {
    const segments = deriveYieldSourceSegments([
      { ts: 1_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 2_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 3_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startTs: 1_000,
      endTs: 3_000,
      sourceKey: "aave-v3",
      sourceLabel: "Aave V3",
      isOther: false,
    });
    expect(segments[0].color).toMatch(/^bg-/);
  });

  it("splits at each source switch and preserves boundaries", () => {
    const segments = deriveYieldSourceSegments([
      { ts: 1_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 2_000, sourceKey: "aave-v3", sourceLabel: "Aave V3" },
      { ts: 3_000, sourceKey: "compound-v3", sourceLabel: "Compound V3" },
      { ts: 4_000, sourceKey: "compound-v3", sourceLabel: "Compound V3" },
      { ts: 5_000, sourceKey: "morpho", sourceLabel: "Morpho" },
      { ts: 6_000, sourceKey: "morpho", sourceLabel: "Morpho" },
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ startTs: 1_000, endTs: 2_000, sourceKey: "aave-v3" });
    expect(segments[1]).toMatchObject({ startTs: 3_000, endTs: 4_000, sourceKey: "compound-v3" });
    expect(segments[2]).toMatchObject({ startTs: 5_000, endTs: 6_000, sourceKey: "morpho" });
  });

  it("collapses sources beyond the top-5 cap into an 'other' lane", () => {
    const history = [
      { ts: 1, sourceKey: "src-a", sourceLabel: "Source A" },
      { ts: 2, sourceKey: "src-b", sourceLabel: "Source B" },
      { ts: 3, sourceKey: "src-c", sourceLabel: "Source C" },
      { ts: 4, sourceKey: "src-d", sourceLabel: "Source D" },
      { ts: 5, sourceKey: "src-e", sourceLabel: "Source E" },
      { ts: 6, sourceKey: "src-f", sourceLabel: "Source F" },
      { ts: 7, sourceKey: "src-g", sourceLabel: "Source G" },
    ];
    const segments = deriveYieldSourceSegments(history);

    expect(segments).toHaveLength(7);
    const topKeys = segments.slice(0, 5).map((segment) => segment.sourceKey);
    expect(topKeys).toEqual(["src-a", "src-b", "src-c", "src-d", "src-e"]);
    expect(segments[5]).toMatchObject({ sourceKey: "other", sourceLabel: "other", isOther: true });
    expect(segments[6]).toMatchObject({ sourceKey: "other", sourceLabel: "other", isOther: true });
    expect(segments[5].color).toBe(segments[6].color);
  });
});
