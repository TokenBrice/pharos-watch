// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NonUsdShareChart } from "@/components/non-usd-share-chart";

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

    fireEvent.click(screen.getByRole("button", { name: /open large share chart/i }));
    expect(onOpenFocus).toHaveBeenCalledWith("1y");
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
