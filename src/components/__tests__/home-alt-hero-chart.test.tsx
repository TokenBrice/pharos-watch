// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAltHeroChart } from "@/components/home-alt-hero-chart";
import { CHART_SLATE_SOFT, CHART_SLATE_STRONG } from "@/lib/chart-colors";

vi.mock("@/hooks/use-chart-shell", () => ({
  useChartShell: () => ({
    chartContainerRef: { current: null },
    isChartReady: true,
    width: 900,
    height: 360,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("HomeAltHeroChart", () => {
  const rows = [
    {
      ts: Date.UTC(2020, 8, 13),
      usdt: 40,
      usdc: 10,
      sky: 3,
      others: 6,
      nonUsd: 2,
      total: 61,
    },
    {
      ts: Date.UTC(2026, 5, 1),
      usdt: 70,
      usdc: 20,
      sky: 4,
      others: 12,
      nonUsd: 5,
      total: 111,
    },
  ];

  it("renders lines for every market cohort represented by the legend", () => {
    const { container } = render(
      <HomeAltHeroChart rows={rows} />,
    );

    const pathTitles = Array.from(container.querySelectorAll("path title")).map((title) => title.textContent);
    expect(pathTitles).toEqual(
      expect.arrayContaining([
        "Total market cap",
        "USDT",
        "USDC",
        "USDS + DAI",
        "Others",
        "Non-USD share",
      ]),
    );
  });

  it("keeps the total envelope visually distinct from the Non-USD share line", () => {
    const { container } = render(<HomeAltHeroChart rows={rows} />);
    const titledPath = (label: string) =>
      Array.from(container.querySelectorAll("path title")).find((title) => title.textContent === label)
        ?.parentElement;

    const totalPath = titledPath("Total market cap");
    const nonUsdPath = titledPath("Non-USD share");

    expect(totalPath?.getAttribute("stroke")).toBe(CHART_SLATE_SOFT);
    expect(nonUsdPath?.getAttribute("stroke")).toBe(CHART_SLATE_STRONG);
    expect(nonUsdPath?.getAttribute("stroke-dasharray")).toBe("4 4");
  });

  it("keeps the final x-axis label away from the SVG edge", () => {
    const { container } = render(<HomeAltHeroChart rows={rows} />);

    const lastTick = Array.from(container.querySelectorAll("text")).find((text) => text.textContent === "Jun 26");
    const lastTickX = Number(lastTick?.getAttribute("x"));

    expect(lastTick?.getAttribute("text-anchor")).toBe("middle");
    expect(900 - lastTickX).toBeGreaterThanOrEqual(32);
  });

  it("keeps the top y-axis label clear of the SVG edge", () => {
    const { container } = render(<HomeAltHeroChart rows={rows} />);

    const topTick = Array.from(container.querySelectorAll("text")).find((text) => text.textContent?.startsWith("$"));
    const topTickY = Number(topTick?.getAttribute("y"));

    expect(topTickY).toBeGreaterThanOrEqual(24);
  });
});
