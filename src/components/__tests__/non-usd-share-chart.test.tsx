// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NonUsdShareChart } from "@/components/non-usd-share-chart";
import { formatChartDate } from "@shared/lib/format";

const { useNonUsdShareMock, handleAnimationEndMock } = vi.hoisted(() => ({
  useNonUsdShareMock: vi.fn(),
  handleAnimationEndMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useNonUsdShare: useNonUsdShareMock,
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

describe("NonUsdShareChart", () => {

  beforeEach(() => {
    useNonUsdShareMock.mockReturnValue({
      data: [
        {
          date: 1_619_827_200, // Apr 25, 2021
          commodityShare: 2,
          fiatNonUsdShare: 0.7,
          commodity: 20,
          fiatNonUsd: 7,
          total: 1_000,
        },
        {
          date: 1_713_657_600, // Apr 5, 2024
          commodityShare: 1.4,
          fiatNonUsdShare: 0.8,
          commodity: 18,
          fiatNonUsd: 12,
          total: 1_300,
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it("defaults to 1Y and renders explicit coverage/provenance copy", () => {
    const onOpenFocus = vi.fn();

    render(<NonUsdShareChart onOpenFocus={onOpenFocus} />);

    expect(screen.getByRole("heading", { name: /share of total stablecoin market outside usd/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/coverage starts/i)).toBeTruthy();
    expect(screen.getByText(/non-commodity bucket includes currency-linked plus other non-commodity pegs/i)).toBeTruthy();
    expect(
      screen.getByRole("table", { name: /share of total stablecoin market outside usd over 1 points/i }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open large share chart/i }));
    expect(onOpenFocus).toHaveBeenCalledWith("1y");
  });

  it("identifies retained history by the latest sample date, not the request date", () => {
    const saved = useNonUsdShareMock();
    useNonUsdShareMock.mockReturnValue({
      ...saved,
      error: new Error("Refresh failed"),
      dataUpdatedAt: Date.now(),
    });
    render(<NonUsdShareChart />);
    const latestDate = formatChartDate(saved.data[1].date * 1000, "long");
    expect(screen.getByText(`As of ${latestDate}:`, { exact: false }).textContent).toContain("2.20%");
    expect(screen.queryByText(/current share/i)).toBeNull();
  });

  it("does not invent a zero share for unavailable history", () => {
    useNonUsdShareMock.mockReturnValue({ data: undefined, isLoading: false });
    render(<NonUsdShareChart />);
    expect(screen.getByText("No market share data available")).toBeTruthy();
    expect(screen.queryByText(/0\\.00%/)).toBeNull();
    expect(screen.queryByText(/As of/)).toBeNull();
  });

  it("qualifies a partial latest value cohort in the headline, accessible label and table", () => {
    const saved = useNonUsdShareMock();
    useNonUsdShareMock.mockReturnValue({
      ...saved,
      data: saved.data.map((point: object) => ({ ...point,
        coverage: { basis: "interior-gap-prior-value", total: 0.99, commodity: 0.8, fiatNonUsd: 0.6 },
      })),
    });
    render(<NonUsdShareChart />);
    const latestDate = formatChartDate(saved.data[1].date * 1000, "long");
    const headline = screen.getByText(`As of ${latestDate}:`, { exact: false });
    expect(headline.textContent).toContain("Partial value coverage: total 99.0%, commodities 80.0%, non-commodity 60.0%");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("Partial value coverage");
    expect(screen.getByRole("table").textContent).toContain("Partial value coverage");
  });

  it("marks legacy history without value coverage as unknown rather than complete", () => {
    render(<NonUsdShareChart />);
    expect(screen.getByRole("table").textContent).toContain("Value coverage unavailable");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("Value coverage unavailable");
  });

  it("supports focused mode and reports range changes", () => {
    const onCloseFocus = vi.fn();
    const onRangeChange = vi.fn();

    render(
      <NonUsdShareChart
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

    fireEvent.click(screen.getByRole("button", { name: /return share chart to overview/i }));
    expect(onCloseFocus).toHaveBeenCalled();
  });
});
