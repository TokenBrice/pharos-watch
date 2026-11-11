// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YieldHistoryPoint } from "@shared/types/yield-evidence-schemas";
import { YieldHistoryChart } from "@/components/yield/yield-history-chart";
import { deriveYieldSourceSegments, getYieldHistorySourceDisplayLabel, useYieldHistoryChartModel } from "@/components/yield/yield-history-chart-model";
import { useYieldHistoryChartQueries } from "@/components/yield/yield-history-chart-queries";
import { SourceStrip, WarningDot, YieldHistoryTooltip } from "@/components/yield/yield-history-chart-ui";

const { useYieldHistoryMock } = vi.hoisted(() => ({
  useYieldHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/api-hooks")>(),
  useYieldHistory: useYieldHistoryMock,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueries: ({ queries, combine }: {
    queries: { queryKey: readonly unknown[]; enabled?: boolean }[];
    combine: (results: unknown[]) => unknown;
  }) => combine(queries.map(({ queryKey, enabled }) => {
    const [, stablecoinId, days, mode, sourceKey] = queryKey;
    const readHistory = useYieldHistoryMock;
    const result = readHistory(stablecoinId, { days, mode, sourceKey, enabled });
    return { ...result, data: result.data === undefined ? undefined : { data: result.data, meta: result.meta ?? null } };
  })),
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({
    ref: { current: null },
    ready: false,
    width: 0,
    height: 0,
  }),
}));

afterEach(() => {
  useYieldHistoryMock.mockReset();
});

describe("YieldHistoryChart", () => {
  it.each(["error", "retained-error", "warning", "header-warning", "degraded", "loading", "stale", "primary-error"] as const)(
    "qualifies requested source %s without hiding successful observations",
    (state) => {
      const retry = vi.fn();
      const date = Date.now();
      const point = { date, apy: 9, apyBase: null, apyReward: null, sourceTvlUsd: null, warningSignals: [] };
      useYieldHistoryMock.mockImplementation((_id, options) => {
        const affected = options.sourceKey === (state === "primary-error" ? "primary" : "alternate");
        const error = affected && ["error", "retained-error", "primary-error"].includes(state) ? new Error("history refresh failed") : null;
        return {
          data: affected && ["error", "loading", "primary-error"].includes(state)
            ? undefined
            : { history: [point], ...(affected && state === "warning" ? { warning: "Source history incomplete" } : {}) },
          meta: !affected ? null
            : state === "stale" ? { updatedAt: date / 1000 - 100000, status: "stale" }
            : state === "header-warning" ? { status: "degraded", warning: '110 - "Response is stale"' }
            : state === "degraded" ? { updatedAt: date / 1000, status: "degraded", reason: "yield-publication-age" }
            : null,
          dataUpdatedAt: date, isLoading: affected && state === "loading", error, refetch: retry,
        };
      });
      render(<YieldHistoryChart stablecoinId="test" benchmarkRate={null} medianApy={null}
        externalSourceKeys={["primary", "alternate"]}
        availableSources={[{ sourceKey: "primary", yieldSource: "Primary" }, { sourceKey: "alternate", yieldSource: "Alternate" }]} />);
      expect(screen.getByRole("figure")).toBeTruthy();
      const status = screen.getByLabelText(`${state === "primary-error" ? "Primary" : "Alternate"} history status`);
      if (state === "loading") expect(within(status).getByText("Loading history")).toBeTruthy();
      else if (state === "stale") expect(within(status).getByText("Showing an older snapshot")).toBeTruthy();
      // Failed refreshes, body/header advisories and degraded clocks over retained
      // observations are operator signal (ADR-42).
      else if (["retained-error", "warning", "header-warning", "degraded"].includes(state)) {
        expect(status.textContent).toBe("");
        expect(screen.queryByText("Source history incomplete")).toBeNull();
        expect(screen.queryByText("Response is stale")).toBeNull();
      } else {
        expect(within(status).getByRole("status")).toBeTruthy();
        fireEvent.click(within(status).getByRole("button", { name: "Retry" }));
        expect(retry).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([null, 5])("inspects alternate APY with primary APY %s and disambiguated identities", (primaryApy) => {
    const sources = [
      { sourceKey: "aave:ethereum:usdc", yieldSource: "Aave" },
      { sourceKey: "aave:base:usdc", yieldSource: "Aave" },
      { sourceKey: "other", yieldSource: "Other" },
    ];
    const identities = sources.map((source) => ({ sourceKey: source.sourceKey, label: getYieldHistorySourceDisplayLabel(source, sources) }));
    const point = { date: Date.UTC(2026, 8, 1), apy: primaryApy, apy_overlay_0: 9, apy_overlay_1: null,
      apyBase: null, apyReward: null, sourceTvlUsd: null, warningSignals: [], sourceKey: sources[0].sourceKey,
      yieldSource: primaryApy === null ? null : "Aave", dataSource: null, isBest: false, sourceSwitch: false };
    render(<YieldHistoryTooltip active label={point.date} payload={[{ dataKey: "apy_overlay_0", payload: point }]}
      primarySource={identities[0]} overlaySources={identities.slice(1)} showBreakdown compact={false} />);
    expect(screen.getByText(identities[0].label).parentElement?.textContent).toContain(primaryApy === null ? "Unavailable" : "5.00%");
    expect(screen.getByText(identities[1].label).parentElement?.textContent).toContain("9.00%");
    expect(screen.getByText("Other").parentElement?.textContent).toContain("Unavailable");
    if (primaryApy === null) expect(screen.queryByText("Primary source")).toBeNull();
  });

  it("positions source intervals and point-only events at measured timestamps", () => {
    const start = Date.UTC(2026, 8, 1);
    const segments = deriveYieldSourceSegments([
      { ts: start, sourceKey: "a" }, { ts: start + 1000, sourceKey: "a" },
      { ts: start + 2000, sourceKey: "b" }, { ts: start + 3000, sourceKey: "b" },
      { ts: start + 4000, sourceKey: "a" },
    ]);
    const { container } = render(<SourceStrip segments={segments} timeStart={start} timeEnd={start + 4000} />);
    const blocks = container.querySelectorAll("[title]");
    expect(blocks).toHaveLength(3);
    expect((blocks[0] as HTMLElement).style.left).toBe("0%");
    expect((blocks[0] as HTMLElement).style.width).toBe("25%");
    expect((blocks[1] as HTMLElement).style.left).toBe("50%");
    expect((blocks[1] as HTMLElement).style.width).toBe("25%");
    expect((blocks[2] as HTMLElement).style.left).toBe("100%");
    expect((blocks[2] as HTMLElement).style.width).toBe("2px");
  });

  it("exposes publish-time PYS snapshots on the full chart", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      date: Date.UTC(2026, 3, index + 1),
      apy: 4 + index * 0.01,
      apyBase: null,
      apyReward: null,
      exchangeRate: null,
      sourceTvlUsd: 1_000_000,
      warningSignals: [],
      sourceKey: "primary-source",
      yieldSource: "Primary Source",
      dataSource: "defillama",
      isBest: true,
      sourceSwitch: false,
      pysAtPublish: 60 + index,
    }));
    useYieldHistoryMock.mockImplementation((_stablecoinId, options) => ({
      data: options?.enabled === false
        ? { current: null, history: [], methodology: { version: "v8.14" } }
        : { current: null, history, methodology: { version: "v8.14" } },
      meta: null,
      error: null,
      isLoading: false,
    }));

    render(
      <YieldHistoryChart
        stablecoinId="dola-inverse-finance"
        benchmarkRate={3}
        benchmarkLabel="SOFR"
        medianApy={4}
        compact={false}
      />,
    );

    expect(screen.queryByTestId("pys-sparkline")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show APY and PYS breakdown detail"));
    expect(screen.getByTestId("pys-sparkline")).toBeTruthy();
    expect(screen.getByText(/PYS 89 \(\+29\)/)).toBeTruthy();
  });

  it("names the canonical series and plots all requested overlays (F6, E19)", () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      date: Date.UTC(2026, 3, index + 1),
      apy: 4 + index * 0.01,
      apyBase: null,
      apyReward: null,
      exchangeRate: null,
      sourceTvlUsd: 1_000_000,
      warningSignals: [],
      sourceKey: "primary-source",
      yieldSource: "Primary Source",
      dataSource: "defillama",
      isBest: true,
      sourceSwitch: false,
    }));
    useYieldHistoryMock.mockImplementation((_stablecoinId, options) => ({
      data: options?.enabled === false
        ? { current: null, history: [], methodology: { version: "v8.14" } }
        : { current: null, history, methodology: { version: "v8.14" } },
      meta: null,
      error: null,
      isLoading: false,
    }));

    // E19: overlays beyond the old 4-source cap must still be requested.
    render(
      <YieldHistoryChart
        stablecoinId="usdc-circle"
        benchmarkRate={3}
        benchmarkLabel="SOFR"
        medianApy={0}
        externalSourceKeys={["a", "b", "c", "d", "e", "f", "g"]}
        availableSources={[
          { sourceKey: "a", yieldSource: "Source A" },
          { sourceKey: "b", yieldSource: "Source B" },
          { sourceKey: "g", yieldSource: "Source G" },
        ]}
      />,
    );
    const requestedSourceKeys = useYieldHistoryMock.mock.calls
      .map(([, options]) => (options?.sourceKey ?? null))
      .filter(Boolean);
    for (const key of ["b", "c", "d", "e", "f", "g"]) {
      expect(requestedSourceKeys).toContain(key);
    }
  });

  it("keeps published mixed-source history distinct from the current source's series", () => {
    const date = Date.UTC(2026, 8, 1);
    const history = [
      { date, apy: 2, apyBase: null, apyReward: null, sourceTvlUsd: null, warningSignals: [], sourceKey: "old" },
      { date: date + 86_400_000, apy: 4, apyBase: null, apyReward: null, sourceTvlUsd: null, warningSignals: [], sourceKey: "current" },
    ];
    useYieldHistoryMock.mockImplementation((_id, options) => ({
      data: { history: options.mode === "best" ? history : history.filter((point) => point.sourceKey === options.sourceKey) },
      isLoading: false, error: null,
    }));
    const props = { stablecoinId: "zchf-frankencoin", benchmarkRate: null, medianApy: null,
      availableSources: [{ sourceKey: "current", yieldSource: "Current" }] };
    const { result, rerender } = renderHook(
      ({ source }: { source?: string }) => useYieldHistoryChartModel({ ...props, externalSourceKey: source }),
      { initialProps: { source: undefined } as { source?: string } },
    );
    expect(result.current.chartData.map((point) => point.apy)).toEqual([2, 4]);
    rerender({ source: "current" });
    expect(result.current.chartData.map((point) => point.apy)).toEqual([4]);
    render(<YieldHistoryChart {...props} />);
    expect(screen.getByText(/Selected source over time.*headline 30d APY/)).toBeTruthy();
    expect(screen.queryByText(/Global TVL-weighted median/)).toBeNull();
  });

  it("preserves publication-cadence gaps and alternate-only timestamps", () => {
    const cadenceMs = 2 * 3_600_000;
    const start = Math.floor(Date.now() / cadenceMs) * cadenceMs - 5 * cadenceMs;
    const makePoint = (date: number, apy: number) => ({
      date, apy, apyBase: apy, apyReward: 0, sourceTvlUsd: null, warningSignals: [],
    });
    useYieldHistoryMock.mockImplementation((_id, options) => ({
      data: { history: options.sourceKey === "alternate"
        ? [makePoint(start + cadenceMs, 8)]
        : [makePoint(start, 2), makePoint(start + 3 * cadenceMs, 3)] },
      isLoading: false, error: null,
    }));
    const { result } = renderHook(() => useYieldHistoryChartModel({
      stablecoinId: "test", benchmarkRate: null, medianApy: null,
      externalSourceKeys: ["primary", "alternate"],
    }));
    const rows = result.current.mergedChartData;
    expect(rows.find((point) => point.date === start + cadenceMs)).toMatchObject({ apy: null, apy_overlay_0: 8 });
    expect(rows.find((point) => point.date === start + 2 * cadenceMs)).toMatchObject({ apy: null, apyBase: null, apyReward: null, apy_overlay_0: null });
    expect(rows.find((point) => point.date === start + 3 * cadenceMs)?.apy).toBe(3);
    // Rows inside one publication bucket are not a gap.
    expect(rows.some((point) => point.date === start + 3_600_000)).toBe(false);
  });

  it("uses daily missing buckets outside hourly retention", () => {
    const start = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 60 * 86_400_000;
    useYieldHistoryMock.mockReturnValue({
      data: { history: [start, start + 2 * 86_400_000].map((date) => ({
        date, apy: 3, apyBase: null, apyReward: null, sourceTvlUsd: null, warningSignals: [],
      })) }, isLoading: false, error: null,
    });
    const { result } = renderHook(() => useYieldHistoryChartModel({
      stablecoinId: "test", benchmarkRate: null, medianApy: null,
    }));
    expect(result.current.mergedChartData.map(({ date, apy }) => [date, apy])).toEqual([
      [start, 3], [start + 86_400_000, null], [start + 2 * 86_400_000, 3],
    ]);
  });

  it("distinguishes unreadable warnings from a clean history point", () => {
    const point = { date: Date.UTC(2026, 8, 1), apy: 3, apyBase: null, apyReward: null,
      sourceTvlUsd: null, warningSignals: [], sourceKey: null, yieldSource: null,
      dataSource: null, isBest: true, sourceSwitch: false, warningSignalsStatus: "unreadable" as const };
    const { rerender } = render(<svg><WarningDot cx={10} cy={20} payload={point} /></svg>);
    expect(screen.getByLabelText("Warnings unreadable")).toBeTruthy();
    rerender(<svg><WarningDot cx={10} cy={20} payload={{ ...point, warningSignalsStatus: undefined }} /></svg>);
    expect(screen.queryByLabelText("Warnings unreadable")).toBeNull();
    render(<YieldHistoryTooltip active label={point.date} payload={[{ dataKey: "apy", payload: point }]} showBreakdown={false} compact={false} />);
    expect(screen.getByText("Warnings unreadable")).toBeTruthy();
    expect(screen.queryByText("Warning signals")).toBeNull();
  });
  it("draws no warning marker or tooltip section for operational advisories only", () => {
    const point = { date: Date.UTC(2026, 8, 1), apy: 3, apyBase: null, apyReward: null,
      sourceTvlUsd: null, warningSignals: ["aging", "data-stale"], sourceKey: null, yieldSource: null,
      dataSource: null, isBest: true, sourceSwitch: false };
    const { container } = render(<svg><WarningDot cx={10} cy={20} payload={point} /></svg>);
    expect(container.querySelector("circle")).toBeNull();
    const mixed = { ...point, warningSignals: ["aging", "yield-spike"] };
    render(<YieldHistoryTooltip active label={mixed.date} payload={[{ dataKey: "apy", payload: mixed }]} showBreakdown={false} compact={false} />);
    expect(screen.getByText("Yield spike")).toBeTruthy();
    expect(screen.queryByText("Aging observation")).toBeNull();
  });
});

// The model cases below drive the chart model through the same hook mock the chart cases use.
const historyBySource = new Map<string, YieldHistoryPoint[]>();
const BASE = Date.UTC(2026, 0, 1);
function point(date: number, apy: number, overrides: Partial<YieldHistoryPoint> = {}): YieldHistoryPoint {
  return { date, apy, apyBase: null, apyReward: null, exchangeRate: null,
    sourceTvlUsd: null, warningSignals: [], ...overrides };
}
const chartProps = { stablecoinId: "fixture", benchmarkRate: 5, medianApy: 5 };

describe("yield history transformations", () => {
  it.each([undefined, [], ["a"], ["a", "b"], ["a", "b", "c", "d", "e", "f", "g", "h", "i"]].map((sourceKeys) => ({ sourceKeys })))(
    "preserves mounted query slots and disabled requests for $sourceKeys", ({ sourceKeys }) => {
      useYieldHistoryMock.mockClear();
      const { result } = renderHook(() => useYieldHistoryChartQueries("fixture", 30, "best", sourceKeys));
      const primary = sourceKeys?.[0] ?? "best";
      const additional = sourceKeys?.slice(1) ?? [];
      expect(useYieldHistoryMock.mock.calls).toEqual([
        ["fixture", { days: 30, mode: primary === "best" ? "best" : "source", sourceKey: primary === "best" ? null : primary }],
        ...Array.from({ length: 7 }, (_, index) => ["fixture", {
          days: 30, mode: "source", sourceKey: additional[index] ?? null, enabled: additional.length > index,
        }]),
      ]);
      expect(result.current.overlaySources.map((source) => source.sourceKey)).toEqual(additional.slice(0, 7));
      expect(result.current.overlaySources.every((source) => source.color != null)).toBe(true);
      expect(result.current.omittedOverlayKeys).toEqual(sourceKeys?.slice(8) ?? []);
    },
  );

  beforeEach(() => {
    useYieldHistoryMock.mockImplementation((_id: string, options: { sourceKey: string | null; enabled?: boolean }) => ({
      data: { history: options.enabled === false ? [] : historyBySource.get(options.sourceKey ?? "best") ?? [] },
    }));
  });
  afterEach(() => {
    historyBySource.clear();
  });

  it("prioritizes overlays, caps the cohort at eight, and drops stale internal selection", () => {
    const sources = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((sourceKey) => ({ sourceKey, yieldSource: sourceKey }));
    for (const [index, source] of sources.entries()) historyBySource.set(source.sourceKey, [point(BASE, index + 5)]);
    const { result, rerender } = renderHook(
      ({ availableSources, externalSourceKeys }: { availableSources: typeof sources; externalSourceKeys?: string[] }) =>
        useYieldHistoryChartModel({ ...chartProps, availableSources, externalSourceKeys }),
      { initialProps: { availableSources: sources, externalSourceKeys: undefined as string[] | undefined } },
    );
    act(() => result.current.onSourceChange?.("b"));
    expect(result.current.chartData[0].apy).toBe(6);
    rerender({ availableSources: sources, externalSourceKeys: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] });
    expect(result.current.selectedSourceKey).toBe("b");
    expect(result.current.primarySourceKey).toBe("a");
    expect(result.current.mergedChartData[0]).toMatchObject({
      apy: 5,
      apy_overlay_0: 6,
      apy_overlay_1: 7,
      apy_overlay_2: 8,
      apy_overlay_3: 9,
      apy_overlay_4: 10,
      apy_overlay_5: 11,
      apy_overlay_6: 12,
    });
    expect(result.current.overlayLabels.map((source) => source.dataKey)).toEqual([
      "apy_overlay_0",
      "apy_overlay_1",
      "apy_overlay_2",
      "apy_overlay_3",
      "apy_overlay_4",
      "apy_overlay_5",
      "apy_overlay_6",
    ]);
    // The 9th source sits beyond the mounted query capacity and is reported, not silently dropped.
    expect(result.current.omittedOverlayKeys).toEqual(["i"]);
    historyBySource.set("best", [point(BASE, 3)]);
    rerender({ availableSources: sources.filter((source) => source.sourceKey !== "b"), externalSourceKeys: undefined });
    expect(result.current.selectedSourceKey).toBe("best");
    expect(result.current.primarySourceKey).toBe("best");
    expect(result.current.chartData[0].apy).toBe(3);
  });

  it("preserves actual timestamps across seconds and milliseconds without inventing observations", () => {
    historyBySource.set("a", [point(BASE / 1000 + 10, 5), point(BASE + 3_600_000 + 10_000, 6), point(BASE + 7_200_000 + 10_000, 7)]);
    historyBySource.set("b", [point(BASE + 300_000, 8.5), point(BASE / 1000 + 3600 + 300, 9.5)]);
    const { result } = renderHook(() => useYieldHistoryChartModel({ ...chartProps, externalSourceKeys: ["a", "b"] }));
    expect(result.current.mergedChartData.map(({ date, apy, apy_overlay_0 }) => [date, apy, apy_overlay_0]))
      .toEqual([
        [BASE + 10_000, 5, null], [BASE + 300_000, null, 8.5],
        [BASE + 3_610_000, 6, null], [BASE + 3_900_000, null, 9.5],
        [BASE + 7_210_000, 7, null],
      ]);
  });

  it("uses the trailing thirty-day window and requires a strict spike ratio", () => {
    historyBySource.set("best", [
      point(BASE, 0.5),
      ...[31, 32, 33].map((day) => point(BASE + day * 86_400_000, 4)),
      point(BASE + 34 * 86_400_000, 8),
    ]);
    const { result, rerender } = renderHook(() => useYieldHistoryChartModel(chartProps));
    // Exactly 2× is not a spike: the worker's `yield-spike` signal needs > 2×.
    expect(result.current.spikeAnnotations).toEqual([]);
    historyBySource.set("best", [
      point(BASE, 0.5),
      ...[31, 32, 33].map((day) => point(BASE + day * 86_400_000, 4)),
      point(BASE + 34 * 86_400_000, 8.01),
    ]);
    rerender();
    expect(result.current.spikeAnnotations).toEqual([
      { date: BASE + 34 * 86_400_000, apy: 8.01, trailingAvg: 4, ratio: 8.01 / 4, windowDays: 3 },
    ]);
    historyBySource.set("best", [
      ...[0, 1, 2].map((day) => point(BASE + day * 86_400_000, 0.5)),
      point(BASE + 3 * 86_400_000, 2),
      point(BASE + 4 * 86_400_000, 2.01),
    ]);
    rerender();
    expect(result.current.spikeAnnotations.map(({ date, apy }) => [date, apy]))
      .toEqual([[BASE + 4 * 86_400_000, 2.01]]);
  });

  it("averages observed zero and negative APY in the trailing window", () => {
    const DAY = 86_400_000;
    historyBySource.set("best", [
      ...Array.from({ length: 20 }, (_, day) => point(BASE + day * DAY, 2.1)),
      ...Array.from({ length: 5 }, (_, index) => point(BASE + (20 + index) * DAY, 0)),
      ...Array.from({ length: 5 }, (_, index) => point(BASE + (25 + index) * DAY, -1.4)),
      point(BASE + 30 * DAY, 4.5),
    ]);
    const { result } = renderHook(() => useYieldHistoryChartModel(chartProps));

    expect(result.current.spikeAnnotations).toHaveLength(1);
    expect(result.current.spikeAnnotations[0]).toMatchObject({
      date: BASE + 30 * DAY, apy: 4.5, windowDays: 30,
    });
    expect(result.current.spikeAnnotations[0].trailingAvg).toBeCloseTo(35 / 30);
    expect(result.current.spikeAnnotations[0].ratio).toBeCloseTo(4.5 / (35 / 30));
  });

  it("does not annotate a best-source switch as a yield spike", () => {
    const DAY = 86_400_000;
    const TWO_HOURS = 7_200_000;
    const oldSource = Array.from({ length: 30 * 12 }, (_, index) =>
      point(BASE + index * TWO_HOURS, 1.8, { sourceKey: "a" }));
    const switchTs = BASE + 30 * DAY;
    const newSource = Array.from({ length: 2 * 12 }, (_, index) =>
      point(switchTs + index * TWO_HOURS, 3.9, { sourceKey: "b", sourceSwitch: index === 0 }));
    historyBySource.set("best", [...oldSource, ...newSource]);
    const { result, rerender } = renderHook(() => useYieldHistoryChartModel(chartProps));

    expect(result.current.spikeAnnotations).toEqual([]);

    historyBySource.set("best", [
      ...oldSource,
      ...Array.from({ length: 5 }, (_, index) =>
        point(switchTs + index * TWO_HOURS, 3.9, { sourceKey: "b", sourceSwitch: index === 0 })),
      point(switchTs + 5 * TWO_HOURS, 8, { sourceKey: "b" }),
    ]);
    rerender();
    expect(result.current.spikeAnnotations.map(({ date, apy }) => [date, apy]))
      .toEqual([[switchTs + 5 * TWO_HOURS, 8]]);
  });

  it("bounds source-mode baselines by source identity, not the is_best flip flag", () => {
    const DAY = 86_400_000;
    const sourceKey = "source-s";
    const availableSources = [{ sourceKey, yieldSource: "Source S" }];
    const chart = (history: YieldHistoryPoint[]) => {
      historyBySource.set(sourceKey, history);
      return renderHook(() => useYieldHistoryChartModel({ ...chartProps, externalSourceKey: sourceKey, availableSources }));
    };

    // The source's own jump over its 30-day mean is annotated even though the
    // row where it gains the is_best slot carries `sourceSwitch`.
    const { result, rerender } = chart([
      ...Array.from({ length: 30 }, (_, day) => point(BASE + day * DAY, 0.5, { sourceKey })),
      point(BASE + 30 * DAY, 3, { sourceKey, sourceSwitch: true }),
    ]);
    expect(result.current.spikeAnnotations).toEqual([
      { date: BASE + 30 * DAY, apy: 3, trailingAvg: 0.5, ratio: 6, windowDays: 30 },
    ]);

    // A post-flip dip is averaged with the source's own 30-day history, not a
    // baseline restarted at the is_best flip.
    historyBySource.set(sourceKey, [
      ...Array.from({ length: 60 }, (_, day) => point(BASE + day * DAY, 5, { sourceKey })),
      ...Array.from({ length: 6 }, (_, index) =>
        point(BASE + (60 + index) * DAY, 1, { sourceKey, sourceSwitch: index === 0 })),
      point(BASE + 67 * DAY, 2.2, { sourceKey }),
    ]);
    rerender();
    expect(result.current.spikeAnnotations).toEqual([]);
  });

  it("never labels a future-inclusive series mean as a trailing average", () => {
    const DAY = 86_400_000;
    historyBySource.set("best", [
      ...Array.from({ length: 60 }, (_, day) => point(BASE + day * DAY, 0)),
      point(BASE + 60 * DAY, 50),
      ...Array.from({ length: 304 }, (_, index) => point(BASE + (61 + index) * DAY, 5)),
    ]);
    const { result, rerender } = renderHook(() => useYieldHistoryChartModel(chartProps));

    expect(result.current.spikeAnnotations.some((spike) => spike.date === BASE + 60 * DAY)).toBe(false);
    for (const spike of result.current.spikeAnnotations) {
      const points = historyBySource.get("best")!.filter(
        (entry) => Number(entry.date) < spike.date && Number(entry.date) >= spike.date - spike.windowDays * DAY,
      );
      const expected = points.reduce((sum, entry) => sum + entry.apy, 0) / points.length;
      expect(spike.trailingAvg).toBeCloseTo(expected, 10);
    }

    historyBySource.set("best", [
      point(BASE, 12),
      ...Array.from({ length: 29 }, (_, index) => point(BASE + (index + 1) * DAY, 1)),
    ]);
    rerender();
    expect(result.current.spikeAnnotations).toEqual([]);
  });

  it("does not average a stitched best-mode source switch into a yield spike", () => {
    const DAY = 86_400_000;
    const previousSource = Array.from({ length: 20 }, (_, day) =>
      point(BASE + day * DAY, 3, { sourceKey: "a", sourceSwitch: false }));
    historyBySource.set("best", [
      ...previousSource,
      point(BASE + 20 * DAY, 8, { sourceKey: "b", sourceSwitch: true }),
    ]);
    const { result, rerender } = renderHook(() => useYieldHistoryChartModel(chartProps));
    expect(result.current.spikeAnnotations).toEqual([]);

    // The same jump inside one source is still a spike.
    historyBySource.set("best", [
      ...previousSource,
      point(BASE + 20 * DAY, 8, { sourceKey: "a", sourceSwitch: false }),
    ]);
    rerender();
    expect(result.current.spikeAnnotations).toEqual([
      { date: BASE + 20 * DAY, apy: 8, trailingAvg: 3, ratio: 8 / 3, windowDays: 20 },
    ]);
  });

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
    expect(segments[5]).toMatchObject({ sourceKey: "src-f", sourceLabel: "Source F", isOther: true });
    expect(segments[6]).toMatchObject({ sourceKey: "src-g", sourceLabel: "Source G", isOther: true });
    expect(segments[5].color).toBe(segments[6].color);
  });

  it("preserves point-only switches and repeated source identity without invented intervals", () => {
    expect(deriveYieldSourceSegments([
      { ts: 1000, sourceKey: "a" }, { ts: 2000, sourceKey: "b" },
      { ts: 3000, sourceKey: "b" }, { ts: 4000, sourceKey: "a" },
    ]).map(({ startTs, endTs, sourceKey }) => ({ startTs, endTs, sourceKey }))).toEqual([
      { startTs: 1000, endTs: 1000, sourceKey: "a" },
      { startTs: 2000, endTs: 3000, sourceKey: "b" },
      { startTs: 4000, endTs: 4000, sourceKey: "a" },
    ]);
  });
});
