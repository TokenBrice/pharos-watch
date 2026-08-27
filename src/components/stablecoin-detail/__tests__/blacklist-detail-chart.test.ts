// @vitest-environment jsdom

import { createElement, isValidElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuarterlyStackedBarChart } from "@/components/chart-primitives/quarterly-stacked-bar-chart";
import { BlacklistDetailChart } from "@/components/stablecoin-detail/blacklist-detail-chart";

const { quarterlyChartMock } = vi.hoisted(() => ({
  quarterlyChartMock: vi.fn((_: Parameters<typeof QuarterlyStackedBarChart>[0]) => null),
}));

vi.mock("@/components/chart-primitives/quarterly-stacked-bar-chart", () => ({
  QuarterlyStackedBarChart: quarterlyChartMock,
}));

afterEach(() => {
  cleanup();
  quarterlyChartMock.mockClear();
});

describe("BlacklistDetailChart", () => {
  it("keeps its domain chrome while configuring the shared quarterly frame", () => {
    const data = [
      { quarter: "Q1 '26", blacklist: 3, unblacklist: 1, destroy: 2 },
      { quarter: "Q2 '26", blacklist: 4, unblacklist: 0, destroy: 0 },
    ];

    render(createElement(BlacklistDetailChart, { data, isLoading: false }));

    expect(screen.getByText("Events per Quarter")).toBeTruthy();
    expect(screen.getByText("Blacklist")).toBeTruthy();
    expect(screen.getByText("Unblacklist")).toBeTruthy();
    expect(screen.getByText("Destroy")).toBeTruthy();
    expect(quarterlyChartMock).toHaveBeenCalledOnce();
    const props = quarterlyChartMock.mock.calls[0]![0];
    expect(props.data).toBe(data);
    expect(props.series).toEqual([
      { dataKey: "blacklist", color: "#ef4444", fillOpacity: 0.8 },
      { dataKey: "unblacklist", color: "#10b981", fillOpacity: 0.7 },
      { dataKey: "destroy", color: "#f59e0b", fillOpacity: 0.75, radius: [3, 3, 0, 0] },
    ]);
    expect(props.yAxis).toEqual({ allowDecimals: false, width: 48 });
    expect(props.ariaLabel).toBe("Quarterly blacklist events chart showing 2 quarters");
    expect(props.height).toBe("h-[220px] sm:h-[260px]");
    expect(isValidElement(props.tooltipContent)).toBe(true);
    expect(props.children).toBeUndefined();
  });

  it("keeps the feature-owned empty state outside the shared chart", () => {
    render(createElement(BlacklistDetailChart, { data: [], isLoading: false }));

    expect(screen.getByText(/Insufficient data/)).toBeTruthy();
    expect(quarterlyChartMock).not.toHaveBeenCalled();
  });
});
