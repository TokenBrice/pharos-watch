// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AltPegCohortHistoryChart } from "@/app/alt-pegs/alt-peg-cohort-history-chart";
import { Tooltip } from "recharts";
import type { ReactElement } from "react";
import type * as ChartAxes from "@/components/chart-primitives/axes";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { StablecoinChartPoint } from "@shared/types/supply";
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

const sample = (date: number, totalCirculatingUSD: StablecoinChartPoint["totalCirculatingUSD"]) => ({ date, totalCirculatingUSD });

function showAll() {
  chartState.ready = true;
  render(<AltPegCohortHistoryChart initialRange="all" />);
}

describe("AltPegCohortHistoryChart", () => {

  beforeEach(() => {
    chartState.ready = false;
    chartState.selectedIndex = 0;
    useStablecoinChartsMock.mockReturnValue({
      data: [
        sample(1_582_156_800, {
          peggedEUR: 1_000_000,
          peggedGOLD: 4_000_000,
        }),
        sample(1_713_657_600, {
          peggedEUR: 60_000_000,
          peggedGOLD: 20_000_000,
          peggedBRL: 8_000_000,
          peggedVAR: 2_000_000,
        }),
      ],
      isLoading: false,
      dataUpdatedAt: Date.now(),
      meta: { updatedAt: Math.floor(Date.now() / 1000), status: "fresh", ageSeconds: 0 },
    });
  });

  it("defaults to 1Y and renders explicit cohort-history provenance copy", () => {
    const onOpenFocus = vi.fn();

    render(<AltPegCohortHistoryChart onOpenFocus={onOpenFocus} />);

    expect(screen.getByRole("heading", { name: /non-usd market cap by peg/i })).toBeTruthy();
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

  it("starts pegs and Other at first samples", async () => {
    showAll();
    const total = await screen.findByText("Total");
    expect(total.nextElementSibling?.textContent).toBe("$5.00M");
    expect(total.parentElement!.parentElement!.textContent).not.toMatch(/Other|Brazilian/);
    expect(within(screen.getByRole("table")).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([["$1.00M", "$4.00M", "", ""], ["$60.00M", "$20.00M", "$8.00M", "$2.00M"]]);
  });

  it("excludes USD and preserves explicit-zero historical cohorts in Other at the $5m boundary", async () => {
    useStablecoinChartsMock.mockReturnValue({
      isLoading: false,
      data: [
        sample(1_713_571_200, { peggedUSD: 900_000_000_000, peggedEUR: 6_000_000, peggedJPY: 3_000_000, peggedBRL: 0 }),
        sample(1_713_657_600, { peggedUSD: 900_000_000_000, peggedEUR: 5_000_000, peggedBRL: 4_999_999, peggedJPY: 0 }),
      ],
    });
    showAll();
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("3 peg currencies");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toBe("$9.00M");
    expect(screen.getAllByText(PEG_LABELS_SHORT.EUR)).toHaveLength(3);
    expect(screen.getByText(`(${PEG_LABELS_SHORT.BRL}, ${PEG_LABELS_SHORT.JPY})`)).toBeTruthy();
    expect(screen.queryByText(PEG_LABELS_SHORT.USD)).toBeNull();
  });

  it("withholds incomplete latest totals and Other instead of inventing zeros", async () => {
    chartState.selectedIndex = 1;
    useStablecoinChartsMock.mockReturnValue({
      isLoading: false,
      data: [
        sample(1_713_571_200, { peggedJPY: 3_000_000 }),
        sample(1_713_657_600, { peggedEUR: 5_000_000, peggedBRL: 2_000_000, peggedUSD: 900_000_000_000 }),
      ],
    });
    showAll();
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toBe("Unavailable");
    expect(within(screen.getByRole("table")).getAllByText("Unavailable").length).toBeGreaterThan(0);
  });

  it("keeps invalid major and folded buckets as chart/table gaps but preserves later explicit zeros", async () => {
    chartState.selectedIndex = 1;
    useStablecoinChartsMock.mockReturnValue({
      ...useStablecoinChartsMock(),
      data: [
        sample(1_713_398_400, { peggedEUR: 6_000_000, peggedJPY: 1_000_000 }),
        sample(1_713_484_800, { peggedEUR: null, peggedJPY: null }),
        sample(1_713_571_200, { peggedEUR: 0, peggedJPY: 0 }),
        sample(1_713_657_600, { peggedEUR: 6_000_000, peggedJPY: 0 }),
      ],
    });
    showAll();
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
    expect(screen.getByText(/latest sample April 21, 2024/)).toBeTruthy();
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
