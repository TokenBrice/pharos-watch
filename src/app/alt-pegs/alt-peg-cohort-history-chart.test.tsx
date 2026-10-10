// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AltPegCohortHistoryChart } from "@/app/alt-pegs/alt-peg-cohort-history-chart";
import { Tooltip } from "recharts";
import type { ReactElement } from "react";
import type * as ChartAxes from "@/components/chart-primitives/axes";
import { PEG_CHART_COLORS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

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
      dataUpdatedAt: Date.now(),
      meta: { updatedAt: Math.floor(Date.now() / 1000), status: "fresh", ageSeconds: 0 },
    });
  });

  it("defaults to 1Y and renders explicit cohort-history provenance copy", () => {
    const onOpenFocus = vi.fn();

    render(<AltPegCohortHistoryChart onOpenFocus={onOpenFocus} />);

    expect(screen.getByRole("heading", { name: /alt-peg market cap by cohort/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/coverage starts/i)).toBeTruthy();
    expect(screen.getByText(/historical provider-wide cohort feed includes selected structural history overlays/i)).toBeTruthy();
    expect(screen.getByText(/No current core-universe point is appended because the populations differ/i)).toBeTruthy();
    expect(
      screen.getByRole("table", { name: /alt-peg market cap by cohort over 1 points/i }),
    ).toBeTruthy();

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

  it("excludes USD and preserves explicit-zero historical cohorts in Other at the $5m boundary", async () => {
    chartState.ready = true;
    useStablecoinChartsMock.mockReturnValue({
      isLoading: false,
      data: [
        { date: 1_713_571_200, totalCirculatingUSD: { peggedUSD: 900_000_000_000, peggedEUR: 6_000_000, peggedJPY: 3_000_000, peggedBRL: 0 } },
        { date: 1_713_657_600, totalCirculatingUSD: { peggedUSD: 900_000_000_000, peggedEUR: 5_000_000, peggedBRL: 4_999_999, peggedJPY: 0 } },
      ],
    });
    render(<AltPegCohortHistoryChart initialRange="all" />);
    expect(screen.getByText(/latest provider-wide sample/).textContent).toContain("$10.0M");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("3 peg currencies");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toBe("$9.00M");
    expect(screen.getAllByText(PEG_CHART_COLORS.EUR.label)).toHaveLength(3);
    expect(screen.getByText(`(${PEG_CHART_COLORS.BRL.label}, ${PEG_CHART_COLORS.JPY.label})`)).toBeTruthy();
    expect(screen.queryByText(PEG_LABELS_SHORT.USD)).toBeNull();
  });

  it("withholds incomplete latest totals and Other instead of inventing zeros", async () => {
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
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toBe("Unavailable");
    expect(screen.getByText(/latest provider-wide sample/).textContent).toContain("Unavailable");
    expect(within(screen.getByRole("table")).getAllByText("Unavailable").length).toBeGreaterThan(0);
  });

  it("keeps invalid major and folded buckets as chart/table gaps but preserves later explicit zeros", async () => {
    chartState.ready = true;
    chartState.selectedIndex = 1;
    useStablecoinChartsMock.mockReturnValue({
      ...useStablecoinChartsMock(),
      data: [
        { date: 1_713_398_400, totalCirculatingUSD: { peggedEUR: 6_000_000, peggedJPY: 1_000_000 } },
        { date: 1_713_484_800, totalCirculatingUSD: { peggedEUR: null, peggedJPY: null } },
        { date: 1_713_571_200, totalCirculatingUSD: { peggedEUR: 0, peggedJPY: 0 } },
        { date: 1_713_657_600, totalCirculatingUSD: { peggedEUR: 6_000_000, peggedJPY: 0 } },
      ],
    });
    render(<AltPegCohortHistoryChart initialRange="all" />);
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(within(rows[1]).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Unavailable", "Unavailable"]);
    expect(within(rows[2]).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["$0.00", "$0.00"]);
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toBe("Unavailable");
  });

  it.each([0, 20])("uses chart-specific producer metadata for %s age budgets and labels the sample date", (budgets) => {
    const now = Date.now();
    const ageSeconds = budgets * API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts;
    useStablecoinChartsMock.mockReturnValue({
      ...useStablecoinChartsMock(),
      dataUpdatedAt: now,
      meta: { updatedAt: Math.floor(now / 1000) - ageSeconds, ageSeconds, status: "fresh" },
    });
    render(<AltPegCohortHistoryChart />);
    expect(screen.getByText(/latest provider-wide sample/).textContent).toContain("April 21, 2024");
    expect(screen.getByText(/historical provider-wide cohort feed/)).toBeTruthy();
    expect(screen.queryByText("Showing an older snapshot") !== null).toBe(budgets > 0);
    if (budgets > 0) expect(screen.getByText(/Alt-Peg Cohort History/)).toBeTruthy();
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
