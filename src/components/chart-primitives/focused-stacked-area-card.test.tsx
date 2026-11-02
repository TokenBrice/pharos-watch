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

  function renderRange(data: Array<{ ts: number; a: number; b: number }>, range: "7d" | "1y") {
    return render(
      <FocusedStackedAreaCard
        data={data}
        tsKey="ts"
        isLoading={false}
        title="Stack"
        loadingTitle="Stack"
        initialRange={range}
        rangeOptions={[range]}
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
        yDomain={() => [0, "auto"]}
        yTickFormatter={String}
        tableColumns={[]}
        tableCaption={() => "Stack"}
        cardClassName=""
        legendClassName=""
      />,
    );
  }

  function xTickLabels(container: HTMLElement): string[] {
    // MonoYAxis is mocked above, so every rendered tick belongs to the time axis.
    return [...container.querySelectorAll(".recharts-cartesian-axis-tick-value")]
      .map((node) => node.textContent ?? "")
      .filter((label) => label.length > 0);
  }

  it("labels a day-scale range with distinct day-level ticks", () => {
    const day = 86_400_000;
    const end = Date.UTC(2026, 9, 31);
    const { container } = renderRange(
      Array.from({ length: 8 }, (_, index) => ({ ts: end - (7 - index) * day, a: 10 + index, b: 5 })),
      "7d",
    );

    const labels = xTickLabels(container);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toMatch(/^Oct \d+$/);
  });

  it("keeps month labels on a year-scale range", () => {
    const day = 86_400_000;
    const end = Date.UTC(2026, 9, 31);
    const { container } = renderRange(
      Array.from({ length: 14 }, (_, index) => ({ ts: end - (13 - index) * 30 * day, a: 10 + index, b: 5 })),
      "1y",
    );

    const labels = xTickLabels(container);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).toMatch(/^[A-Z][a-z]{2} '\d{2}$/);
  });
});
