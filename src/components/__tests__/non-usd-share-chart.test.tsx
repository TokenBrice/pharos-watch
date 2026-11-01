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

    const { container } = render(<NonUsdShareChart onOpenFocus={onOpenFocus} />);
    // Unframed on /alt-pegs/: the chart stage is the only frame (no card around it).
    expect(container.querySelector(".pharos-card-shell")).toBeNull();

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
    // The dated share figure itself is the page hero's; the chart names the sample in its label and fold.
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain(`2.20% share as of ${latestDate}`);
    expect(screen.getByText(`Latest sample (${latestDate})`, { exact: false })).toBeTruthy();
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
    const note = screen.getByText(`Latest sample (${latestDate})`, { exact: false });
    expect(note.textContent).toContain("Partial value coverage: total 99.0%, commodities 80.0%, non-commodity 60.0%");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("Partial value coverage");
    expect(screen.getByRole("table").textContent).toContain("Partial value coverage");
  });

  it("never prints a partial coverage shortfall as complete", () => {
    const saved = useNonUsdShareMock();
    useNonUsdShareMock.mockReturnValue({
      ...saved,
      data: saved.data.map((point: object) => ({ ...point,
        coverage: { basis: "interior-gap-prior-value", total: 0.9996, commodity: 0.9999, fiatNonUsd: 0.9998 },
      })),
    });
    const { container } = render(<NonUsdShareChart />);

    expect(container.textContent).toContain("Partial value coverage");
    expect(container.textContent).toContain("<100%");
    expect(container.textContent).not.toContain("100.0%");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("<100%");
  });

  it("keeps exact full coverage printed as 100.0%", () => {
    const saved = useNonUsdShareMock();
    useNonUsdShareMock.mockReturnValue({
      ...saved,
      data: saved.data.map((point: object) => ({ ...point,
        coverage: { basis: "interior-gap-prior-value", total: 1, commodity: 1, fiatNonUsd: 1 },
      })),
    });
    render(<NonUsdShareChart />);

    expect(screen.getByRole("figure").getAttribute("aria-label"))
      .toContain("Interior-gap value coverage: total 100.0%, commodities 100.0%, non-commodity 100.0%");
  });

  it("marks legacy history without value coverage as unknown rather than complete", () => {
    render(<NonUsdShareChart />);
    expect(screen.getByRole("table").textContent).toContain("Value coverage unavailable");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("Value coverage unavailable");
  });

});
