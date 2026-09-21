// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FlowChart } from "@/components/flow-chart";

const chartState = vi.hoisted(() => ({
  data: [] as Array<Record<string, number | boolean | null>>,
  connectNulls: undefined as boolean | undefined,
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: vi.fn(), ready: true, width: 800, height: 320 }),
}));

vi.mock("@/hooks/use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: () => true,
}));

vi.mock("@/components/chart-primitives/axes", () => ({
  TimeXAxis: () => null,
  MonoYAxis: () => null,
  TimeGrid: () => null,
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
  Tooltip: () => null,
  ReferenceLine: () => null,
  ReferenceArea: () => null,
}));

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
    ]);
    expect(screen.getByText(/shown as breaks and excluded from rolling averages/i)).toBeTruthy();
  });
});
