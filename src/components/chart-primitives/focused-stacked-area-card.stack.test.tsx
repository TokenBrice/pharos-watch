// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FocusedStackedAreaCard, type StackedAreaSeries } from "@/components/chart-primitives/focused-stacked-area-card";

const chartState = vi.hoisted(() => ({ data: undefined as Array<Record<string, unknown>> | undefined }));

vi.mock("@/hooks/use-chart-shell", () => ({
  useChartShell: () => ({
    animProps: {},
    handleAnimationEnd: vi.fn(),
    chartContainerRef: { current: null },
    isChartReady: true,
    width: 640,
    height: 320,
  }),
}));

vi.mock("recharts", () => ({
  AreaChart: ({ data, children }: { data?: Array<Record<string, unknown>>; children?: ReactNode }) => {
    chartState.data = data;
    return <div>{children}</div>;
  },
  Area: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

type Row = { ts: number; a: number; b: number | null; c?: number; x?: number; y?: number };

function renderCard(data: Row[], series: StackedAreaSeries[]) {
  return render(
    <FocusedStackedAreaCard
      data={data}
      tsKey="ts"
      isLoading={false}
      title="Stack"
      loadingTitle="Stack"
      initialRange="all"
      rangeOptions={["all"]}
      isFocused={false}
      openFocusLabel="Open"
      closeFocusLabel="Close"
      focusedHeightClassName="h-96"
      ariaLabel="Stack chart"
      emptyMessage="Empty"
      series={series}
      tooltip={<span />}
      yDomain={() => [0, "auto"]}
      yTickFormatter={String}
      tableColumns={[]}
      tableCaption={() => "Stack"}
      cardClassName=""
      legendClassName=""
    />,
  );
}

beforeEach(() => {
  chartState.data = undefined;
});

describe("FocusedStackedAreaCard stack admission", () => {
  it("breaks every band above a missing stack member instead of drawing a partial stack", () => {
    renderCard(
      [
        { ts: 1, a: 6, b: 2, c: 1 },
        { ts: 2, a: 7, b: null, c: 1 },
      ],
      [
        { dataKey: "a", color: "red", gradientId: "a", stackId: "1" },
        { dataKey: "b", color: "blue", gradientId: "b", stackId: "1" },
        { dataKey: "c", color: "green", gradientId: "c", stackId: "1" },
      ],
    );

    expect(chartState.data?.[0]).toEqual({ ts: 1, a: 6, b: 2, c: 1 });
    // b is unavailable at ts=2, so a band above it cannot claim the stack top there.
    expect(chartState.data?.[1]).toEqual({ ts: 2, a: 7, b: null, c: null });
  });

  it("cascades within one stack without touching another stack", () => {
    renderCard(
      [
        { ts: 1, a: 6, b: 2, c: 1, x: 4, y: 3 },
        { ts: 2, a: 7, b: null, c: 1, x: 5, y: 2 },
      ],
      [
        { dataKey: "a", color: "red", gradientId: "a", stackId: "left" },
        { dataKey: "b", color: "blue", gradientId: "b", stackId: "left" },
        { dataKey: "c", color: "green", gradientId: "c", stackId: "left" },
        { dataKey: "x", color: "orange", gradientId: "x", stackId: "right" },
        { dataKey: "y", color: "purple", gradientId: "y", stackId: "right" },
      ],
    );

    expect(chartState.data?.[1]).toEqual({ ts: 2, a: 7, b: null, c: null, x: 5, y: 2 });
  });
});
