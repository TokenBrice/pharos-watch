// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMarketDataChartWindow } from "./use-market-data-chart-window";

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
