// @vitest-environment jsdom

import { createElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, within } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FlowChart } from "@/components/flow-chart";

const originalTz = process.env.TZ;
process.env.TZ = "America/Los_Angeles";
afterAll(() => {
  process.env.TZ = originalTz;
});

const chartState = vi.hoisted(() => ({
  data: [] as Array<Record<string, number | boolean | null>>,
  connectNulls: undefined as boolean | undefined,
  hatchedFrom: [] as number[],
  stopDot: null as { x: number; y: number } | null,
  tickFormatter: undefined as ((ts: number) => string) | undefined,
  tooltipContent: undefined as ReactElement | undefined,
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: vi.fn(), ready: true, width: 800, height: 320 }),
}));

vi.mock("@/hooks/use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: () => true,
}));

vi.mock("@/components/chart-primitives/axes", () => ({
  TimeXAxis: ({ tickFormatter }: { tickFormatter?: (ts: number) => string }) => {
    chartState.tickFormatter = tickFormatter;
    return null;
  },
  MonoYAxis: () => null,
  TimeGrid: () => null,
  useNiceValueAxis: () => ({}),
}));

vi.mock("@/components/chart-primitives/legend", () => ({
  ChartLegendChip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("recharts", () => ({
  ComposedChart: ({ data, children }: { data: Array<Record<string, number | boolean | null>>; children: ReactNode }) => {
    chartState.data = data;
    return <div>{children}</div>;
  },
  Bar: () => null,
  Line: ({ connectNulls }: { connectNulls?: boolean }) => {
    chartState.connectNulls = connectNulls;
    return null;
  },
  Tooltip: ({ content }: { content?: ReactElement }) => {
    chartState.tooltipContent = content;
    return null;
  },
  ReferenceLine: () => null,
  ReferenceArea: ({ x1, fill }: { x1: number; fill?: string }) => {
    if (fill?.startsWith("url(")) chartState.hatchedFrom.push(x1);
    return null;
  },
  DefaultZIndexes: { label: 2000 },
  ReferenceDot: ({ x, y }: { x: number; y: number }) => {
    chartState.stopDot = { x, y };
    return null;
  },
}));

/** Render the captured tooltip element against the first chart bucket. */
function tooltipMarkup(): string {
  const content = chartState.tooltipContent!;
  const datum = chartState.data[0];
  return renderToStaticMarkup(createElement(content.type as ComponentType<Record<string, unknown>>, {
    ...(content.props as Record<string, unknown>),
    active: true,
    label: datum.ts as number,
    payload: [{ dataKey: "net", value: datum.net, color: "", name: "", payload: datum }],
  }));
}

describe("FlowChart", () => {
  it("preserves missing hourly buckets as gaps and excludes them from the rolling mean", () => {
    const firstHour = 3_600_000;
    render(
      <FlowChart
        isLoading={false}
        hourly={[
          { hourTs: firstHour, mintVolumeUsd: 7, burnVolumeUsd: 0, netFlowUsd: 7 },
          { hourTs: firstHour + 7_200, mintVolumeUsd: 14, burnVolumeUsd: 0, netFlowUsd: 14 },
        ]}
      />,
    );

    expect(chartState.data).toHaveLength(3);
    expect(chartState.data[1]).toMatchObject({
      mint: null,
      burn: null,
      net: null,
      positiveDelta: null,
      negativeDelta: null,
      cumulative: null,
      rollingNet: null,
    });
    expect(chartState.data[2]).toMatchObject({ cumulative: 21, rollingNet: 10.5 });
    expect(chartState.connectNulls).toBe(false);

    const missingRow = screen.getAllByRole("row")[2];
    expect(within(missingRow).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "—",
      "—",
      "—",
      "—",
      "—",
      "—",
    ]);
    expect(screen.getByText(/shown as breaks and excluded from rolling averages/i)).toBeTruthy();
  });

  it("draws no net for a partial-valuation bucket and stops the cumulative line there", () => {
    chartState.hatchedFrom = [];
    chartState.stopDot = null;
    const firstHour = 3_600_000;
    render(
      <FlowChart
        isLoading={false}
        hourly={[
          { hourTs: firstHour, mintVolumeUsd: 7, burnVolumeUsd: 0, netFlowUsd: 7, valuation: "complete" },
          { hourTs: firstHour + 3_600, mintVolumeUsd: 5, burnVolumeUsd: 0, netFlowUsd: 5, valuation: "partial" },
          { hourTs: firstHour + 7_200, mintVolumeUsd: 14, burnVolumeUsd: 0, netFlowUsd: 14, valuation: "complete" },
        ]}
      />,
    );

    expect(chartState.data[1]).toMatchObject({
      mint: 5,
      net: null,
      positiveDelta: null,
      negativeDelta: null,
      cumulative: null,
      valuation: "partial",
    });
    // The later complete bucket still draws its bar, but the running total is unproven.
    expect(chartState.data[2]).toMatchObject({ net: 14, positiveDelta: 14, cumulative: null });

    const partialRow = screen.getAllByRole("row")[2];
    expect(within(partialRow).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "≥ $5",
      "≥ $0",
      "—",
      "—",
      "Partial valuation: net unavailable",
      "—",
    ]);
    expect(screen.getByText(/1 hourly bucket has a withheld net/i)).toBeTruthy();
    // The withheld net is a hatched column over its bucket, and the line's last proven point is marked.
    expect(chartState.hatchedFrom).toEqual([(firstHour + 3_600) * 1000 - 1_800_000]);
    expect(chartState.stopDot).toEqual({ x: firstHour * 1000, y: 7 });
  });
  it.each([0, 100])("labels fully priced unscanned chart volumes (%i) as observed subtotals", (volume) => {
    render(<FlowChart isLoading={false} hourly={[{
      hourTs: 3_600_000, mintVolumeUsd: volume, burnVolumeUsd: 0, netFlowUsd: null,
      valuation: "complete", scanCoverage: { complete: false, unavailableReason: "scan-coverage-incomplete" },
    }]} />);
    expect(chartState.data[0]).toMatchObject({ valuation: "complete", scanComplete: false, net: null });
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent))
      .toEqual([`≥ $${volume}`, "≥ $0", "—", "—", "Complete", "Observed subtotals"]);
    // The withheld net comes from incomplete scan coverage here, not unpriced events.
    expect(screen.getByText("Net withheld")).toBeTruthy();
    expect(screen.getByText(/1 hourly bucket has a withheld net/i)).toBeTruthy();
    expect(screen.queryByText(/unpriced events/i)).toBeNull();
  });

  it("renders hourly bucket labels in UTC regardless of the viewer timezone", () => {
    const hourTs = Date.UTC(2026, 10, 1) / 1000;
    render(<FlowChart isLoading={false} hourly={[
      { hourTs, mintVolumeUsd: 1, burnVolumeUsd: 0, netFlowUsd: 1 },
      { hourTs: hourTs + 3_600, mintVolumeUsd: 1, burnVolumeUsd: 0, netFlowUsd: 1 },
    ]} />);
    expect(chartState.tickFormatter?.(hourTs * 1000)).toBe("00:00");
    expect(tooltipMarkup()).toContain("Nov 1, 2026, 12:00 AM");
  });

  it("qualifies only the 30d window's partial edge days as observed subtotals", () => {
    const windowStart = Date.UTC(2026, 9, 2, 16) / 1000;
    const windowEnd = windowStart + 30 * 86_400;
    render(
      <FlowChart
        isLoading={false}
        publishedWindow={{ start: windowStart, end: windowEnd }}
        hourly={[
          { hourTs: windowStart, mintVolumeUsd: 10, burnVolumeUsd: 0, netFlowUsd: 10, valuation: "complete" },
          { hourTs: windowStart + 2 * 86_400, mintVolumeUsd: 20, burnVolumeUsd: 0, netFlowUsd: 20, valuation: "complete" },
          { hourTs: windowEnd - 3_600, mintVolumeUsd: 30, burnVolumeUsd: 0, netFlowUsd: 30, valuation: "complete" },
        ]}
      />,
    );

    expect(chartState.data).toHaveLength(31);
    expect(chartState.data[0]).toMatchObject({
      ts: Date.UTC(2026, 9, 2),
      mint: 10,
      net: 10,
      scanComplete: false,
    });
    expect(chartState.data[2]).toMatchObject({ mint: 20, net: 20, scanComplete: true });
    expect(chartState.data[30]).toMatchObject({
      ts: Date.UTC(2026, 10, 1),
      mint: 30,
      net: 30,
      scanComplete: false,
    });

    const firstRow = screen.getAllByRole("row")[1];
    expect(within(firstRow).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Oct 2, 00:00"]);
    expect(within(firstRow).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "≥ $10",
      "≥ $0",
      "$10",
      "$10",
      "Complete",
      "Observed subtotals",
    ]);
    const lastRow = screen.getAllByRole("row").at(-1)!;
    expect(within(lastRow).getAllByRole("cell")[5].textContent).toBe("Observed subtotals");
  });

  it("leaves daily edge buckets complete without a published window", () => {
    const windowStart = Date.UTC(2026, 9, 2, 16) / 1000;
    const windowEnd = windowStart + 30 * 86_400;
    render(
      <FlowChart
        isLoading={false}
        hourly={[
          { hourTs: windowStart, mintVolumeUsd: 10, burnVolumeUsd: 0, netFlowUsd: 10 },
          { hourTs: windowEnd - 3_600, mintVolumeUsd: 30, burnVolumeUsd: 0, netFlowUsd: 30 },
        ]}
      />,
    );

    expect(chartState.data[0]).toMatchObject({ net: 10, scanComplete: true });
    expect(chartState.data.at(-1)).toMatchObject({ net: 30, scanComplete: true });
  });

  it("renders daily bucket labels in UTC regardless of the viewer timezone", () => {
    const dayTs = Date.UTC(2026, 9, 1) / 1000;
    render(<FlowChart isLoading={false} hourly={[
      { hourTs: dayTs, mintVolumeUsd: 1, burnVolumeUsd: 0, netFlowUsd: 1 },
      { hourTs: dayTs + 30 * 86_400, mintVolumeUsd: 1, burnVolumeUsd: 0, netFlowUsd: 1 },
    ]} />);
    expect(chartState.tickFormatter?.(dayTs * 1000)).toBe("Oct 1");
    expect(tooltipMarkup()).toContain("Oct 1, 2026");
  });
});
