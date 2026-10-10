// @vitest-environment jsdom

import { fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { deriveYieldSourceSegments, getYieldHistorySourceDisplayLabel, useYieldHistoryChartModel } from "@/components/yield-history-chart-model";
import { SourceStrip, WarningDot, YieldHistoryTooltip } from "@/components/yield-history-chart-ui";

const { useYieldHistoryMock } = vi.hoisted(() => ({
  useYieldHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useYieldHistory: useYieldHistoryMock,
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
  it.each(["error", "retained-error", "warning", "loading", "stale", "primary-error"] as const)(
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
          meta: affected && state === "stale" ? { updatedAt: date / 1000 - 100000, status: "stale" } : null,
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
      else {
        if (state === "warning") expect(within(status).getByText("Source history incomplete")).toBeTruthy();
        else expect(within(status).getByRole("status")).toBeTruthy();
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

  it("counts distinct grouped sources rather than repeated segments", () => {
    const start = Date.UTC(2026, 8, 1);
    const segments = deriveYieldSourceSegments(["a", "b", "c", "b"].map((sourceKey, index) => ({
      ts: start + index * 1000, sourceKey,
    })), { maxDistinctSources: 1 });
    render(<SourceStrip segments={segments} timeStart={start} timeEnd={start + 3000} />);
    expect(screen.getByText("other (2)")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("b from");
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

    // The publish-time PYS strip now rides the breakdown toggle.
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

    render(
      <YieldHistoryChart
        stablecoinId="usdc-circle"
        benchmarkRate={3}
        benchmarkLabel="SOFR"
        medianApy={0}
        availableSources={[
          { sourceKey: "a", yieldSource: "Source A" },
          { sourceKey: "b", yieldSource: "Source B" },
        ]}
      />,
    );


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

  it("preserves hourly gaps and alternate-only timestamps", () => {
    const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 5 * 3_600_000;
    const makePoint = (date: number, apy: number) => ({
      date, apy, apyBase: apy, apyReward: 0, sourceTvlUsd: null, warningSignals: [],
    });
    useYieldHistoryMock.mockImplementation((_id, options) => ({
      data: { history: options.sourceKey === "alternate"
        ? [makePoint(start + 3_600_000, 8)]
        : [makePoint(start, 2), makePoint(start + 3 * 3_600_000, 3)] },
      isLoading: false, error: null,
    }));
    const { result } = renderHook(() => useYieldHistoryChartModel({
      stablecoinId: "test", benchmarkRate: null, medianApy: null,
      externalSourceKeys: ["primary", "alternate"],
    }));
    const rows = result.current.mergedChartData;
    expect(rows.find((point) => point.date === start + 3_600_000)).toMatchObject({ apy: null, apy_overlay_0: 8 });
    expect(rows.find((point) => point.date === start + 2 * 3_600_000)).toMatchObject({ apy: null, apyBase: null, apyReward: null, apy_overlay_0: null });
    expect(rows.find((point) => point.date === start + 3 * 3_600_000)?.apy).toBe(3);
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
});

describe("YieldHistoryTooltip spike copy (E22)", () => {
  it("labels the effective trailing span of the spike average", async () => {
    const { YieldHistoryTooltip } = await import("@/components/yield-history-chart-ui");
    const payloadPoint = {
      date: Date.UTC(2026, 4, 10),
      apy: 9,
      apyBase: null,
      apyReward: null,
      sourceTvlUsd: null,
      warningSignals: [],
      sourceKey: null,
      yieldSource: "Source A",
      dataSource: null,
      isBest: true,
      sourceSwitch: false,
    };
    const { render: rtlRender, screen: rtlScreen } = await import("@testing-library/react");
    rtlRender(
      <YieldHistoryTooltip
        active
        showBreakdown={false}
        compact={false}
        label={Date.UTC(2026, 4, 10)}
        spikesByDate={new Map([[Date.UTC(2026, 4, 10), { trailingAvg: 3, ratio: 3, windowDays: 7 }]])}
        payload={[{ dataKey: "apy", payload: payloadPoint }]}
      />,
    );
    expect(rtlScreen.getByText(/3\.0× the trailing 7d average of 3\.00%/)).toBeTruthy();
  });
});
