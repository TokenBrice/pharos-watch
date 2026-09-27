// @vitest-environment jsdom

import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YieldHistoryChart } from "@/components/yield-history-chart";
import { useYieldHistoryChartModel } from "@/components/yield-history-chart-model";
import { WarningDot, YieldHistoryTooltip } from "@/components/yield-history-chart-ui";

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
