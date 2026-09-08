// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Line: ({ dataKey, name }: { dataKey: string; name: string }) => <span data-line-key={dataKey} data-line-name={name} />,
  ReferenceLine: () => <span data-testid="zero-line" />,
  CartesianGrid: () => <span />,
  Tooltip: ({ content }: { content?: (props: unknown) => ReactNode }) => content
    ? content({ active: true, payload: [{ dataKey: "alpha", name: "alpha", value: 10, color: "#111" }], label: 1 })
    : <span data-testid="chart-tooltip" />,
  XAxis: () => <span data-testid="x-axis" />,
  YAxis: () => <span data-testid="y-axis" />,
}));

import {
  MultiSeriesLineChart,
  mergeMultiSeriesData,
} from "@/components/chart-primitives/multi-series-line-chart";

const series = [
  { id: "alpha", label: "Alpha coin", color: "#111", data: [{ ts: 1, value: 10 }, { ts: 2, value: 12 }] },
  { id: "beta", label: "Beta coin", color: "#222", data: [{ ts: 1, value: 20 }] },
];
const scrambledSeries = [
  { id: "alpha", label: "Alpha coin", color: "#111", data: [{ ts: 2, value: 12 }, { ts: 1, value: 10 }] },
  { id: "beta", label: "Beta coin", color: "#222", data: [{ ts: 1, value: 20 }] },
];

describe("MultiSeriesLineChart", () => {
  it("merges scrambled series chronologically without changing payload ids", () => {
    expect(mergeMultiSeriesData(scrambledSeries, (datum) => datum.value)).toEqual([
      { ts: 1, alpha: 10, beta: 20 },
      { ts: 2, alpha: 12 },
    ]);
  });

  it("owns the accessible figure and exposes chronological table values", () => {
    render(
      <MultiSeriesLineChart
        series={series}
        getValue={(datum) => datum.value}
        ariaLabel="Supply comparison chart with 2 series"
        height={200}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        xTickFormatter={String}
        yTickFormatter={String}
        valueFormatter={(value) => `$${value}`}
        tooltipLabelFormatter={(timestamp) => `Tooltip ${timestamp}`}
        tableDateFormatter={(timestamp) => `Date ${timestamp}`}
        tableCaption={(_rows, _truncated, total) => `Supply comparison — ${total} data points`}
      />,
    );

    expect(screen.getByRole("figure", { name: "Supply comparison chart with 2 series" })).toBeTruthy();
    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getByText("Supply comparison — 2 data points")).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Beta coin", hidden: true })).toBeTruthy();
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toBe("Date 1$10$20");
    // Beta has no ts=2 point: the missing series cell renders an em dash.
    expect(rows[2].textContent).toBe("Date 2$12—");
  });

  it("renders the explicit data override instead of merged series data", () => {
    render(
      <MultiSeriesLineChart
        series={series}
        getValue={(datum) => datum.value}
        data={[{ ts: 9, alpha: 42 }]}
        ariaLabel="Override chart"
        height={200}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        xTickFormatter={String}
        yTickFormatter={String}
        valueFormatter={(value) => `$${value}`}
        tooltipLabelFormatter={(timestamp) => `Tooltip ${timestamp}`}
        tableDateFormatter={(timestamp) => `Date ${timestamp}`}
        tableCaption={(rows) => `${rows.length} override rows`}
      />,
    );

    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getByText("1 override rows")).toBeTruthy();
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toBe("Date 9$42—");
  });

  it("preserves feature labels in Pharos tooltip payload rows", () => {
    render(
      <MultiSeriesLineChart
        series={series}
        getValue={(datum) => datum.value}
        ariaLabel="Flow comparison"
        height={200}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        xTickFormatter={String}
        yTickFormatter={String}
        valueFormatter={(value) => `$${value}`}
        tooltipLabelFormatter={(timestamp) => `Tooltip ${timestamp}`}
        tableDateFormatter={String}
        tableCaption={(_rows, _truncated, total) => `${total} points`}
        tooltipVariant="pharos"
      />,
    );

    const figure = screen.getByRole("figure", { name: "Flow comparison" });
    expect(within(figure).getByText("Alpha coin")).toBeTruthy();
    expect(within(figure).getByText("$10")).toBeTruthy();
  });
});
