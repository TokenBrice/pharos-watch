// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  charts: [] as Array<{
    ariaLabel: string;
    tooltipLabelFormatter: (timestamp: number) => string;
    tableDateFormatter: (timestamp: number) => string;
  }>,
}));

vi.mock("@/components/chart-primitives/multi-series-line-chart", () => ({
  mergeMultiSeriesData: (
    series: Array<{ id: string; data: Array<{ ts: number; value: number }> }>,
  ) => {
    const rows = new Map<number, Record<string, number>>();
    for (const item of series) {
      for (const datum of item.data) {
        const row = rows.get(datum.ts) ?? { ts: datum.ts };
        row[item.id] = datum.value;
        rows.set(datum.ts, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.ts - b.ts);
  },
  MultiSeriesLineChart: (props: (typeof captured.charts)[number]) => {
    captured.charts.push(props);
    return null;
  },
}));

import { ComparisonChart } from "@/components/comparison-chart";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";

const SERIES = [
  {
    id: "usdt-tether",
    label: "Tether",
    color: "#111",
    data: [
      { ts: Date.UTC(2022, 0, 5), value: 100 },
      { ts: Date.UTC(2024, 0, 5), value: 120 },
    ],
  },
  {
    id: "usdc-circle",
    label: "USD Coin",
    color: "#222",
    data: [
      { ts: Date.UTC(2022, 0, 5), value: 50 },
      { ts: Date.UTC(2024, 0, 5), value: 60 },
    ],
  },
];

function renderChart(
  range?: TimeRangeOption,
  series = SERIES,
  normalizable = false,
) {
  render(
    <ComparisonChart
      title="Supply"
      series={series}
      range={range}
      onRangeChange={vi.fn()}
      normalizable={normalizable}
    />,
  );
  return captured.charts.at(-1)!;
}

afterEach(() => {
  cleanup();
  captured.charts.length = 0;
});

describe("ComparisonChart date labels", () => {
  it("includes the year in tooltip and accessible-table dates on the default multi-year range", () => {
    const chart = renderChart();
    expect(chart.tooltipLabelFormatter(Date.UTC(2022, 0, 5))).toBe("Jan 5, 2022");
    expect(chart.tooltipLabelFormatter(Date.UTC(2024, 0, 5))).toBe("Jan 5, 2024");
    expect(chart.tableDateFormatter(Date.UTC(2022, 0, 5))).toBe("Jan 5, 2022");
  });

  it("keeps month/day labels on short ranges", () => {
    const chart = renderChart("7d");
    expect(chart.tooltipLabelFormatter(Date.UTC(2022, 0, 5))).toBe("Jan 5");
    expect(chart.tableDateFormatter(Date.UTC(2022, 0, 5))).toBe("Jan 5");
  });
});

describe("ComparisonChart plotted series", () => {
  it("counts only series with a value in the filtered window and dashes the rest", () => {
    const chart = renderChart("7d", [
      SERIES[0],
      {
        ...SERIES[1],
        data: [{ ts: Date.UTC(2022, 0, 5), value: 50 }],
      },
    ]);
    expect(chart.ariaLabel).toBe("Supply comparison chart with 1 series");

    const markers = [...document.querySelectorAll(".pharos-chart-legend-chip")].map(
      (chip) => chip.querySelector("span")!,
    );
    expect(markers).toHaveLength(2);
    expect(markers[0].className).toContain("rounded-full");
    expect(markers[1].className).toContain("border-dashed");
  });

  it("counts series dropped by normalized mode as unplotted", () => {
    renderChart(undefined, [
      SERIES[0],
      {
        ...SERIES[1],
        data: [{ ts: Date.UTC(2024, 0, 5), value: 0 }],
      },
    ], true);

    fireEvent.click(screen.getByText("Normalized %"));

    expect(captured.charts.at(-1)!.ariaLabel).toBe("Supply comparison chart with 1 series");
  });
});
