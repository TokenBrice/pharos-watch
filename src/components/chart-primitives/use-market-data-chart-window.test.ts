// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useMarketDataChartWindow } from "./use-market-data-chart-window";
import { MarketDataChartSyncProvider } from "./sync";

vi.mock("@/hooks/use-chart-annotations", () => ({
  useChartAnnotations: () => ({ data: [] }),
}));

const data = [
  { ts: new Date(2026, 4, 12).getTime() },
  { ts: new Date(2026, 7, 10).getTime() },
];

const margin = { top: 5, right: 12, bottom: 20, left: 5 };


describe("useMarketDataChartWindow", () => {
  it("uses one tick per month for month-oriented ranges", () => {
    const { result } = renderHook(() =>
      useMarketDataChartWindow({
        filteredData: data,
        margin,
        range: "90d",
        stablecoinId: "test-coin",
      }),
    );

    expect(result.current.xTicks).toEqual([
      new Date(2026, 4, 1).getTime(),
      new Date(2026, 5, 1).getTime(),
      new Date(2026, 6, 1).getTime(),
      new Date(2026, 7, 1).getTime(),
    ]);
  });

  it("keeps automatic ticks for day-oriented ranges", () => {
    const { result } = renderHook(() =>
      useMarketDataChartWindow({
        filteredData: data,
        margin,
        range: "30d",
        stablecoinId: "test-coin",
      }),
    );

    expect(result.current.xTicks).toBeUndefined();
  });
});

// renderHook wrapper: injects the real sync provider above the hook (test seam).
const syncWrapper = ({ children }: { children: ReactNode }) =>
  createElement(MarketDataChartSyncProvider, null, children);

describe("useMarketDataChartWindow — brush window", () => {
  it("includes points exactly at both brush endpoints in data and domain", () => {
    const { result } = renderHook(
      () => useMarketDataChartWindow({ filteredData: data, margin, range: "90d", stablecoinId: "test-coin" }),
      { wrapper: syncWrapper },
    );

    act(() => result.current.sync!.setBrushedRange([data[0].ts, data[data.length - 1].ts]));

    expect(result.current.visibleData).toEqual(data);
    expect(result.current.xDomain).toEqual([data[0].ts, data[data.length - 1].ts]);
    expect(result.current.xTicks).toBeDefined();
  });

  it("narrows data and domain to a single-point brush, then restores when cleared", () => {
    const { result } = renderHook(
      () => useMarketDataChartWindow({ filteredData: data, margin, range: "90d", stablecoinId: "test-coin" }),
      { wrapper: syncWrapper },
    );

    act(() => result.current.sync!.setBrushedRange([data[1].ts, data[1].ts]));
    expect(result.current.visibleData).toEqual([data[1]]);
    expect(result.current.xDomain).toEqual([data[1].ts, data[1].ts]);

    act(() => result.current.sync!.setBrushedRange(null));
    expect(result.current.visibleData).toEqual(data);
    expect(result.current.xDomain).toEqual([data[0].ts, data[data.length - 1].ts]);
  });

  it("yields empty data, null domain, and undefined ticks for a brush with no points", () => {
    const { result } = renderHook(
      () => useMarketDataChartWindow({ filteredData: data, margin, range: "90d", stablecoinId: "test-coin" }),
      { wrapper: syncWrapper },
    );

    act(() => result.current.sync!.setBrushedRange([data[0].ts + 1, data[1].ts - 1]));

    expect(result.current.visibleData).toEqual([]);
    expect(result.current.xDomain).toBeNull();
    expect(result.current.xTicks).toBeUndefined();
  });
});
