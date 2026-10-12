// @vitest-environment jsdom

import { render } from "@testing-library/react";
import type * as ChartAxes from "@/components/chart-primitives/axes";
import { describe, expect, it, vi } from "vitest";
import { FocusedStackedAreaCard } from "@/components/chart-primitives/focused-stacked-area-card";

const axisState = vi.hoisted(() => ({ domain: undefined as unknown }));

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

vi.mock("@/components/chart-primitives/axes", async (importOriginal) => {
  const actual = await importOriginal<typeof ChartAxes>();
  return {
    ...actual,
    MonoYAxis: ({ domain }: { domain?: unknown }) => {
      axisState.domain = domain;
      return null;
    },
  };
});

describe("FocusedStackedAreaCard", () => {
  it("pins a raised value floor to zero, since stacked areas fill from zero", () => {
    const day = 86_400_000;
    render(
      <FocusedStackedAreaCard
        data={[
          { ts: day, a: 6, b: 2 },
          { ts: 2 * day, a: 7, b: 2 },
        ]}
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
        series={[
          { dataKey: "a", color: "red", gradientId: "a", stackId: "1" },
          { dataKey: "b", color: "blue", gradientId: "b", stackId: "1" },
        ]}
        tooltip={<span />}
        yDomain={() => [5, 10]}
        yTickFormatter={String}
        tableColumns={[]}
        tableCaption={() => "Stack"}
        cardClassName=""
        legendClassName=""
      />,
    );

    expect(axisState.domain).toEqual([0, 10]);
  });
});
