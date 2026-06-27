// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAltHeroChart } from "@/components/home-alt-hero-chart";

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
  it("renders lines for every market cohort represented by the legend", () => {
    const { container } = render(
      <HomeAltHeroChart
        rows={[
          {
            ts: 1_600_000_000_000,
            usdt: 40,
            usdc: 10,
            sky: 3,
            others: 6,
            nonUsd: 2,
            total: 61,
          },
          {
            ts: 1_700_000_000_000,
            usdt: 70,
            usdc: 20,
            sky: 4,
            others: 12,
            nonUsd: 5,
            total: 111,
          },
        ]}
      />,
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
});
