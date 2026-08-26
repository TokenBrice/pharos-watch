// @vitest-environment jsdom

import { createElement, isValidElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBlacklistChartCoins, getBlacklistTooltipSummary, BlacklistChart } from "@/components/blacklist-chart";
import type { BlacklistSummaryResponse } from "@shared/types";

const { quarterlyChartMock } = vi.hoisted(() => ({
  quarterlyChartMock: vi.fn(() => null),
}));

vi.mock("@/components/chart-primitives/quarterly-stacked-bar-chart", () => ({
  QuarterlyStackedBarChart: quarterlyChartMock,
}));

afterEach(() => {
  cleanup();
  quarterlyChartMock.mockClear();
});

describe("getBlacklistTooltipSummary", () => {
  it("excludes the total series from issuer rows and uses it for the summary total", () => {
    const summary = getBlacklistTooltipSummary([
      { dataKey: "USDT", value: 638_490_000, color: "#1" },
      { dataKey: "USDC", value: 5_540_000, color: "#2" },
      { dataKey: "total", value: 644_040_000, color: "#3" },
    ]);

    expect(summary.rows).toHaveLength(2);
    expect(summary.rows.map((row) => row.dataKey)).toEqual(["USDT", "USDC"]);
    expect(summary.total).toBe(644_040_000);
  });

  it("falls back to summing issuer rows when no total series is present", () => {
    const summary = getBlacklistTooltipSummary([
      { dataKey: "USDT", value: 10_000, color: "#1" },
      { dataKey: "USDC", value: 5_000, color: "#2" },
    ]);

    expect(summary.rows).toHaveLength(2);
    expect(summary.total).toBe(15_000);
  });

  it("derives rendered chart coins from all supported non-zero series", () => {
    const coins = getBlacklistChartCoins([
      {
        quarter: "Q2 '26",
        USDT: 0,
        USDC: 0,
        PYUSD: 0,
        USD1: 0,
        PAXG: 0,
        XAUT: 0,
        USDG: 0,
        RLUSD: 0,
        U: 0,
        USDTB: 0,
        A7A5: 0,
        FDUSD: 0,
        BRZ: 125,
        AUSD: 0,
        EURI: 0,
        USDQ: 0,
        USDO: 0,
        USDX: 0,
        AID: 0,
        TGBP: 0,
        EURC: 0,
        BUIDL: 250,
        total: 375,
      },
    ]);

    expect(coins).toEqual(["BRZ", "BUIDL"]);
  });

  it("configures the shared quarterly frame without changing the issuer series or total overlay", () => {
    const chart = [
      { quarter: "Q1 '26", USDT: 10, USDC: 5, total: 15 },
      { quarter: "Q2 '26", USDT: 20, USDC: 0, total: 20 },
    ] as unknown as BlacklistSummaryResponse["chart"];

    render(createElement(BlacklistChart, { chart, isLoading: false }));

    expect(quarterlyChartMock).toHaveBeenCalledOnce();
    const props = quarterlyChartMock.mock.calls[0]![0];
    expect(props.data).toBe(chart);
    expect(props.series).toEqual([
      { dataKey: "USDC", color: expect.any(String), fillOpacity: 0.75, radius: undefined },
      { dataKey: "USDT", color: expect.any(String), fillOpacity: 0.62, radius: [3, 3, 0, 0] },
    ]);
    expect(props.yAxis.width).toBe(62);
    expect(props.yAxis.tickFormatter(1_000)).toBe("$1K");
    expect(props.ariaLabel).toContain("showing 2 quarters");
    expect(props.height).toBe("h-[220px] sm:h-[280px]");
    expect(isValidElement(props.tooltipContent)).toBe(true);
    expect(isValidElement(props.children)).toBe(true);
    expect(props.children.props.dataKey).toBe("total");
  });
});
