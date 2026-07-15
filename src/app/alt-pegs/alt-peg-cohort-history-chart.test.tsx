// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AltPegCohortHistoryChart } from "@/app/alt-pegs/alt-peg-cohort-history-chart";

const { useStablecoinChartsMock, handleAnimationEndMock } = vi.hoisted(() => ({
  useStablecoinChartsMock: vi.fn(),
  handleAnimationEndMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useStablecoinCharts: useStablecoinChartsMock,
}));

vi.mock("@/hooks/use-chart-shell", () => ({
  useChartShell: () => ({
    animProps: {},
    handleAnimationEnd: handleAnimationEndMock,
    chartContainerRef: { current: null },
    isChartReady: false,
    width: 640,
    height: 320,
  }),
}));

describe("AltPegCohortHistoryChart", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
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
});
