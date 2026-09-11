// @vitest-environment jsdom

import { cloneElement, createElement, isValidElement, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuarterlyStackedBarChart } from "@/components/chart-primitives/quarterly-stacked-bar-chart";
import { BlacklistDetailChart } from "@/components/stablecoin-detail/blacklist-detail-chart";

const { quarterlyChartMock } = vi.hoisted(() => ({
  quarterlyChartMock: vi.fn(),
}));

vi.mock("@/components/chart-primitives/quarterly-stacked-bar-chart", () => ({
  QuarterlyStackedBarChart: quarterlyChartMock,
}));

// The shared frame needs a measured SVG container, so it is replaced by a stub
// that plots the same rows through the feature-owned tooltip: what a reader can
// actually see (accessible name, per-quarter event values) stays under test.
type FrameProps = Parameters<typeof QuarterlyStackedBarChart>[0];

function renderStubbedFrame(props: FrameProps) {
  const rows = props.data as Array<Record<string, number | string>>;
  return createElement(
    "div",
    { role: "img", "aria-label": props.ariaLabel },
    ...rows.map((row) =>
      createElement(
        "div",
        { key: String(row.quarter), "data-testid": `plotted-${String(row.quarter)}` },
        isValidElement(props.tooltipContent)
          ? cloneElement(props.tooltipContent as ReactElement<Record<string, unknown>>, {
              active: true,
              label: row.quarter,
              payload: props.series.map((series) => ({
                dataKey: series.dataKey,
                value: row[series.dataKey],
                color: series.color,
              })),
            })
          : null,
      ),
    ),
  );
}

beforeEach(() => {
  quarterlyChartMock.mockImplementation(renderStubbedFrame);
});

afterEach(() => {
  quarterlyChartMock.mockReset();
});

describe("BlacklistDetailChart", () => {
  it("plots every quarter with its own event tallies and suppresses empty series", () => {
    const data = [
      { quarter: "Q1 '26", blacklist: 3, unblacklist: 1, destroy: 2 },
      { quarter: "Q2 '26", blacklist: 4, unblacklist: 0, destroy: 0 },
    ];

    render(createElement(BlacklistDetailChart, { data, isLoading: false }));

    expect(screen.getByText("Events per Quarter")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Quarterly blacklist events chart showing 2 quarters" })).toBeTruthy();

    expect(screen.getByTestId("plotted-Q1 '26").textContent).toBe("Q1 '26blacklist3unblacklist1destroy2");
    // Zero-count series must not be drawn as rows in the quarter tooltip.
    expect(screen.getByTestId("plotted-Q2 '26").textContent).toBe("Q2 '26blacklist4");
  });

  it("keeps the feature-owned legend for all three event types", () => {
    render(
      createElement(BlacklistDetailChart, {
        data: [{ quarter: "Q1 '26", blacklist: 1, unblacklist: 0, destroy: 0 }],
        isLoading: false,
      }),
    );

    expect(screen.getByText("Blacklist")).toBeTruthy();
    expect(screen.getByText("Unblacklist")).toBeTruthy();
    expect(screen.getByText("Destroy")).toBeTruthy();
  });

  it("keeps the feature-owned empty state outside the shared chart", () => {
    render(createElement(BlacklistDetailChart, { data: [], isLoading: false }));

    expect(screen.getByText(/Insufficient data/)).toBeTruthy();
    expect(quarterlyChartMock).not.toHaveBeenCalled();
  });
});
