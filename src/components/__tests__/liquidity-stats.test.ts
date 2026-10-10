// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiquidityStats } from "@/components/liquidity-stats";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { DEX_GLOBAL_KEY } from "@shared/types/market";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { ...props, alt: props.alt ?? "" }),
}));


describe("LiquidityStats", () => {
  it("renders the exit route map with disclosed tail routes", () => {
    const { container } = render(
      createElement(LiquidityStats, {
        stats: {
          totalTvl: 10_000,
          totalVol: 2_500,
          avgScore: 72,
          withLiquidity: 4,
          highConfidenceCoverage: 3,
          fallbackCoverage: 1,
          totalTracked: 6,
          agg7dChange: null,
          avgBalance: null,
          avgOrganic: null,
        },
        liquidityMap: {
          [DEX_GLOBAL_KEY]: makeDexLiquidityData({
            totalTvlUsd: 10_000,
            totalVolume24hUsd: 2_500,
            protocolTvl: {
              curve: 3_000,
              fluid: 2_000,
              balancer: 1_500,
              orca: 1_000,
              raydium: 900,
              aerodrome: 700,
              quickswap: 400,
            },
            chainTvl: {
              ethereum: 6_000,
              base: 2_000,
              arbitrum: 1_000,
            },
            poolCount: 42,
            concentrationHhi: 0.31,
          }),
        },
      }),
    );

    expect(screen.getByText("Exit Route Map")).toBeTruthy();
    expect(screen.getByTestId("exit-route-instrument").getAttribute("role")).toBe("img");
    expect(screen.getByTestId("exit-route-fallback-list")).toBeTruthy();
    expect(screen.queryByText("Read the route map")).toBeNull();
    expect(screen.queryByRole("group", { name: "Exit route map visual encoding" })).toBeNull();
    expect(screen.getByTestId("protocol-door-curve").getAttribute("data-share-pct")).toBe("30.00");
    expect(screen.getByTestId("protocol-door-_other-routes")).toBeTruthy();
    expect(screen.getByTestId("chain-lane-ethereum").getAttribute("data-share-pct")).toBe("60.00");
    expect(screen.getByTestId("exit-throat").getAttribute("data-crowding-band")).toBe("visible");
    expect(screen.getByTestId("exit-route-flow-markers")).toBeTruthy();
    expect(screen.getByTestId("exit-route-packets-curve")).toBeTruthy();
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Curve");
    expect(screen.getAllByLabelText("Curve protocol door, $3K, 30.0% of DEX TVL")).toHaveLength(2);
    expect(screen.getByText("Leading door:")).toBeTruthy();
    expect(screen.getByText("Leading lane:")).toBeTruthy();
    expect(container.querySelector('image[href="/dexes/curve.png"]')).toBeTruthy();
    expect(container.querySelector('image[href="/chains/ethereum.png"]')).toBeTruthy();
  });

  it("updates the selected route panel from chain and throat interactions", () => {
    render(
      createElement(LiquidityStats, {
        stats: {
          totalTvl: 10_000,
          totalVol: 2_500,
          avgScore: 72,
          withLiquidity: 4,
          highConfidenceCoverage: 3,
          fallbackCoverage: 1,
          totalTracked: 6,
          agg7dChange: null,
          avgBalance: 72,
          avgOrganic: 63,
        },
        liquidityMap: {
          [DEX_GLOBAL_KEY]: makeDexLiquidityData({
            totalTvlUsd: 10_000,
            totalVolume24hUsd: 2_500,
            protocolTvl: {
              curve: 4_000,
              fluid: 2_000,
            },
            chainTvl: {
              ethereum: 5_000,
              base: 2_000,
            },
            poolCount: 42,
            concentrationHhi: 0.31,
            weightedBalanceRatio: 0.72,
            organicFraction: 0.63,
          }),
        },
      }),
    );

    fireEvent.focus(screen.getByTestId("chain-lane-base"));
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Base");
    expect(screen.getByTestId("chain-lane-base").getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("exit-throat"), { key: "Enter" });
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Aggregate exit throat");
    expect(screen.getByTestId("exit-throat").getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("protocol-door-curve"), { key: " " });
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Curve");
    expect(screen.getByTestId("protocol-door-curve").getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    { totalTvl: null, avgScore: null, tvlText: "—", scoreText: "NR" },
    { totalTvl: 0, avgScore: 0, tvlText: "$0.00", scoreText: "0/100" },
  ])("distinguishes unavailable aggregates from measured zeros ($tvlText, $scoreText)", ({
    totalTvl, avgScore, tvlText, scoreText,
  }) => {
    render(createElement(LiquidityStats, {
      stats: {
        totalTvl, avgScore, totalVol: null, withLiquidity: 0, highConfidenceCoverage: 0,
        fallbackCoverage: 0, totalTracked: 6, agg7dChange: null, avgBalance: null, avgOrganic: null,
      },
      liquidityMap: {},
    }));

    const tvlCard = screen.getByText("Total DEX TVL").closest('[data-slot="card"]')!;
    const scoreCard = screen.getByText("Avg Liq Score").closest('[data-slot="card"]')!;
    expect(within(tvlCard as HTMLElement).getByText(tvlText)).toBeTruthy();
    expect(within(scoreCard as HTMLElement).getByText((_content, node) =>
      node?.textContent === scoreText && node.children.length === (avgScore == null ? 0 : 1),
    )).toBeTruthy();
    if (avgScore == null) {
      expect(within(scoreCard as HTMLElement).getByText("NR").className).toContain("text-muted-foreground");
      expect(within(scoreCard as HTMLElement).queryByText("/100")).toBeNull();
      expect(within(scoreCard as HTMLElement).getByText("No active coins have a rated score")).toBeTruthy();
      expect(within(tvlCard as HTMLElement).getByText("Global TVL observation unavailable")).toBeTruthy();
    }
  });
});
