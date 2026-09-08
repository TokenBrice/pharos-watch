// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AltPegCohortHistoryChart } from "@/app/alt-pegs/alt-peg-cohort-history-chart";
import { Tooltip } from "recharts";
import type { ReactElement } from "react";
import type * as ChartAxes from "@/components/chart-primitives/axes";
import { PEG_CHART_COLORS, PEG_LABELS_SHORT } from "@shared/lib/classification";

const { useStablecoinChartsMock, handleAnimationEndMock, chartState } = vi.hoisted(() => ({
  useStablecoinChartsMock: vi.fn(),
  handleAnimationEndMock: vi.fn(),
  chartState: { ready: false, selectedIndex: 0 },
}));

vi.mock("@/hooks/api-hooks", () => ({
  useStablecoinCharts: useStablecoinChartsMock,
}));

vi.mock("@/hooks/use-chart-shell", () => ({
  useChartShell: () => ({
    animProps: {},
    handleAnimationEnd: handleAnimationEndMock,
    chartContainerRef: { current: null },
    isChartReady: chartState.ready,
    width: 640,
    height: 320,
  }),
}));

// Select a point deterministically while retaining Recharts' real series/payload calculation.
vi.mock("@/components/chart-primitives/axes", async (importOriginal) => {
  const actual = await importOriginal<typeof ChartAxes>();
  return {
    ...actual,
    DateTooltip: ({ content }: { content: ReactElement }) => (
      <Tooltip active defaultIndex={chartState.selectedIndex} content={content} />
    ),
  };
});

describe("AltPegCohortHistoryChart", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    chartState.ready = false;
    chartState.selectedIndex = 0;
    useStablecoinChartsMock.mockReturnValue({
      data: [
        {
          date: 1_582_156_800, // Feb 17, 2020
          totalCirculatingUSD: {
            peggedEUR: 1_000_000,
            peggedGOLD: 4_000_000,
          },
        },
        {
          date: 1_713_657_600, // Apr 5, 2024
          totalCirculatingUSD: {
            peggedEUR: 60_000_000,
            peggedGOLD: 20_000_000,
            peggedBRL: 8_000_000,
            peggedVAR: 2_000_000,
          },
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it("defaults to 1Y and renders explicit cohort-history provenance copy", () => {
    const onOpenFocus = vi.fn();

    render(<AltPegCohortHistoryChart onOpenFocus={onOpenFocus} />);

    expect(screen.getByRole("heading", { name: /alt-peg market cap by cohort/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/coverage starts/i)).toBeTruthy();
    expect(screen.getByText(/legacy provider-wide stablecoin-charts cohort feed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open large cohort chart/i }));
    expect(onOpenFocus).toHaveBeenCalledWith("1y");
  });

  it("supports focused mode and range updates", () => {
    const onCloseFocus = vi.fn();
    const onRangeChange = vi.fn();

    render(
      <AltPegCohortHistoryChart
        initialRange="90d"
        isFocused
        onCloseFocus={onCloseFocus}
        onRangeChange={onRangeChange}
      />,
    );

    const activeRange = screen
      .getAllByRole("button", { name: "90D" })
      .find((button) => button.getAttribute("aria-pressed") === "true");
    expect(activeRange?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/focused view/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "30D" }));
    expect(onRangeChange).toHaveBeenCalledWith("30d");

    fireEvent.click(screen.getByRole("button", { name: /return cohort chart to overview/i }));
    expect(onCloseFocus).toHaveBeenCalled();
  });

  it("excludes USD and preserves historical-only supply in Other at the $5m boundary", async () => {
    chartState.ready = true;
    useStablecoinChartsMock.mockReturnValue({
      isLoading: false,
      data: [
        { date: 1_713_571_200, totalCirculatingUSD: { peggedUSD: 900_000_000_000, peggedEUR: 6_000_000, peggedJPY: 3_000_000 } },
        { date: 1_713_657_600, totalCirculatingUSD: { peggedUSD: 900_000_000_000, peggedEUR: 5_000_000, peggedBRL: 4_999_999 } },
      ],
    });
    render(<AltPegCohortHistoryChart initialRange="all" />);
    expect(screen.getByText(/current alt-peg market cap:/).textContent).toContain("$10.0M");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("3 peg currencies");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toBe("$9.00M");
    expect(screen.getAllByText(PEG_CHART_COLORS.EUR.label)).toHaveLength(2);
    expect(screen.getByText(`(${PEG_CHART_COLORS.BRL.label}, ${PEG_CHART_COLORS.JPY.label})`)).toBeTruthy();
    expect(screen.queryByText(PEG_LABELS_SHORT.USD)).toBeNull();
  });

  it("treats missing historical-only supply as zero in the latest tooltip", async () => {
    chartState.ready = true;
    chartState.selectedIndex = 1;
    useStablecoinChartsMock.mockReturnValue({
      isLoading: false,
      data: [
        { date: 1_713_571_200, totalCirculatingUSD: { peggedJPY: 3_000_000 } },
        { date: 1_713_657_600, totalCirculatingUSD: { peggedEUR: 5_000_000, peggedBRL: 2_000_000, peggedUSD: 900_000_000_000 } },
      ],
    });
    render(<AltPegCohortHistoryChart initialRange="all" />);
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toBe("$7.00M");
  });

  it("transitions from loading to an explicit empty-data state", () => {
    useStablecoinChartsMock.mockReturnValue({ isLoading: true, data: undefined });
    const { rerender } = render(<AltPegCohortHistoryChart />);
    expect(screen.getByRole("heading", { name: "Alt-Peg Cohort Growth" })).toBeTruthy();
    expect(screen.queryByText("No cohort-growth data available")).toBeNull();
    useStablecoinChartsMock.mockReturnValue({ isLoading: false, data: [] });
    rerender(<AltPegCohortHistoryChart />);
    expect(screen.getByText("No cohort-growth data available")).toBeTruthy();
    expect(screen.queryByRole("figure")).toBeNull();
  });
});
