// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  balanceRailDashArray,
  buildLiquidityExitRouteModel,
  compactRouteLabel,
  crowdingBand,
  flowIntensityBand,
  organicDashArray,
  protocolRouteGeometry,
  routeMagnitudeScale,
  routePacketCount,
  stableRouteAccentColor,
  throatLabelForCrowding,
  throatGeometry,
} from "@/components/exit-route-model";
import { buildProtocolBreakdown, LiquidityStats } from "@/components/liquidity-stats";
import { DEX_GLOBAL_KEY, type DexLiquidityData } from "@shared/types";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { ...props, alt: props.alt ?? "" }),
}));

afterEach(() => cleanup());

describe("buildProtocolBreakdown", () => {
  it("caps the protocol legend at 10 entries by grouping everything after the top 9", () => {
    const { displayEntries, total } = buildProtocolBreakdown({
      curve: 1_500,
      raydium: 990,
      "uniswap-v3": 850,
      uniswap: 670,
      pancakeswap: 560,
      quickswap: 440,
      fluid: 250,
      orca: 195,
      "sunswap-v3": 176,
      aerodrome: 154,
      balancer: 120,
    });

    expect(total).toBe(5_905);
    expect(displayEntries).toEqual([
      ["curve", 1_500],
      ["raydium", 990],
      ["uniswap-v3", 850],
      ["uniswap", 670],
      ["pancakeswap", 560],
      ["quickswap", 440],
      ["fluid", 250],
      ["orca", 195],
      ["sunswap-v3", 176],
      ["_other", 274],
    ]);
  });

  it("does not add Other when there are 9 or fewer protocols", () => {
    const { displayEntries } = buildProtocolBreakdown({
      curve: 1_500,
      raydium: 990,
      "uniswap-v3": 850,
      uniswap: 670,
      pancakeswap: 560,
      quickswap: 440,
      fluid: 250,
      orca: 195,
      "sunswap-v3": 176,
    });

    expect(displayEntries).toHaveLength(9);
    expect(displayEntries.some(([protocol]) => protocol === "_other")).toBe(false);
  });
});

describe("buildLiquidityExitRouteModel", () => {
  it("derives flow intensity and packet counts from route share", () => {
    expect(flowIntensityBand(30)).toBe("high");
    expect(flowIntensityBand(12)).toBe("medium");
    expect(flowIntensityBand(4)).toBe("low");
    expect(routePacketCount(40)).toBe(5);
    expect(routePacketCount(13)).toBe(3);
    expect(routePacketCount(1)).toBe(1);
    expect(throatLabelForCrowding(0.12)).toBe("Broad route diversity");
    expect(throatLabelForCrowding(0.28)).toBe("Visible route concentration");
    expect(throatLabelForCrowding(0.42)).toBe("Crowded exits");
  });

  it("derives exit routes from the global DEX liquidity row", () => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: {
        totalTvlUsd: 10_000,
        totalVolume24hUsd: 2_500,
        protocolTvl: {
          curve: 5_000,
          fluid: 3_000,
          balancer: 2_000,
        },
        chainTvl: {
          ethereum: 6_000,
          arbitrum: 2_500,
          base: 1_500,
        },
        poolCount: 42,
        concentrationHhi: 0.24,
        weightedBalanceRatio: 0.72,
        organicFraction: 0.63,
      } as DexLiquidityData,
    });

    expect(model).toMatchObject({
      totalTvlUsd: 10_000,
      totalVolume24hUsd: 2_500,
      protocolCount: 3,
      chainCount: 3,
      poolCount: 42,
      concentrationHhi: 0.24,
      weightedBalancePct: 72,
      organicPct: 63,
      interpretation: "Exit depth is usable, but route concentration is visible.",
    });
    expect(model?.topProtocol).toMatchObject({ key: "curve", sharePct: 50, rank: 1, flowIntensity: "high", packetCount: 5 });
    expect(model?.topChain).toMatchObject({ key: "ethereum", sharePct: 60, rank: 1, flowIntensity: "high", packetCount: 5 });
  });

  it("uses total DEX TVL as the route-share denominator when bucket totals drift", () => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: {
        totalTvlUsd: 10_000,
        totalVolume24hUsd: 2_500,
        protocolTvl: {
          curve: 5_000,
          fluid: 3_000,
        },
        chainTvl: {
          ethereum: 4_000,
          base: 1_000,
        },
        poolCount: 42,
        concentrationHhi: null,
        weightedBalanceRatio: null,
        organicFraction: null,
      } as DexLiquidityData,
    }, { avgBalance: 71, avgOrganic: 54 });

    expect(model?.topProtocol).toMatchObject({ key: "curve", sharePct: 50 });
    expect(model?.topChain).toMatchObject({ key: "ethereum", sharePct: 40 });
    expect(model).toMatchObject({
      weightedBalancePct: 71,
      organicPct: 54,
    });
  });

  it("aggregates non-top exit routes into a visible other bucket", () => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: {
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
      } as DexLiquidityData,
    });

    expect(model?.protocolRoutes.map((route) => route.key)).toEqual([
      "curve",
      "fluid",
      "balancer",
      "orca",
      "raydium",
      "_other-routes",
    ]);
    expect(model?.protocolRoutes.at(-1)).toMatchObject({
      label: "Other routes",
      valueUsd: 1_100,
      sharePct: 11,
      isOther: true,
      flowIntensity: "medium",
      packetCount: 2,
    });
  });

  it("does not build an exit map without global TVL", () => {
    expect(buildLiquidityExitRouteModel({})).toBeNull();
    expect(buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: { totalTvlUsd: 0 } as DexLiquidityData,
    })).toBeNull();
  });

  it("keeps visual encodings monotonic, clamped, and resilient to invalid inputs", () => {
    expect(routeMagnitudeScale(-20, 28, 132)).toBe(28);
    expect(routeMagnitudeScale(Number.NaN, 28, 132)).toBe(28);
    expect(routeMagnitudeScale(5, 28, 132)).toBeGreaterThan(routeMagnitudeScale(1, 28, 132));
    expect(routeMagnitudeScale(50, 28, 132)).toBeGreaterThan(routeMagnitudeScale(20, 28, 132));
    expect(routeMagnitudeScale(9_999, 28, 132)).toBe(132);

    expect(crowdingBand(null)).toBe("unknown");
    expect(crowdingBand(0.179)).toBe("broad");
    expect(crowdingBand(0.18)).toBe("visible");
    expect(crowdingBand(0.35)).toBe("crowded");

    expect(organicDashArray(null)).toBeUndefined();
    expect(organicDashArray(70)).toBeUndefined();
    expect(organicDashArray(45)).toBe("10 8");
    expect(organicDashArray(20)).toBe("5 9");
    expect(balanceRailDashArray(null)).toBeUndefined();
    expect(balanceRailDashArray(72)).toBeUndefined();
    expect(balanceRailDashArray(52)).toBe("12 8");
    expect(balanceRailDashArray(30)).toBe("5 8");

    expect(compactRouteLabel("Very Long Protocol Name", 12)).toBe("Very Long P...");
    expect(stableRouteAccentColor("chain:unknown")).toBe(stableRouteAccentColor("chain:unknown"));
    expect(stableRouteAccentColor("chain:unknown")).toMatch(/^oklch\(0\.68 0\.14 \d+\)$/);
  });

  it("derives geometry from the model without React state", () => {
    const model = buildLiquidityExitRouteModel({
      [DEX_GLOBAL_KEY]: {
        totalTvlUsd: 10_000,
        totalVolume24hUsd: 2_500,
        protocolTvl: { curve: 5_000, fluid: 2_500 },
        chainTvl: { ethereum: 6_000, base: 2_000 },
        poolCount: 6_021,
        concentrationHhi: 0.42,
        weightedBalanceRatio: 0.61,
        organicFraction: 0.31,
      } as DexLiquidityData,
    });

    expect(model).not.toBeNull();
    const throat = throatGeometry(model!);
    expect(throat).toMatchObject({
      band: "crowded",
      throatHalfWidth: 22,
      railDashArray: "12 8",
      flowDashArray: "5 9",
      poolTickCount: 12,
    });
    expect(throat.channelPath).toContain("Z");

    const topProtocol = protocolRouteGeometry(model!.protocolRoutes[0], 0);
    const secondProtocol = protocolRouteGeometry(model!.protocolRoutes[1], 1);
    expect(topProtocol.apertureWidth).toBeGreaterThan(secondProtocol.apertureWidth);
    expect(topProtocol.pathD).toContain("M ");
  });
});

describe("LiquidityStats", () => {
  it("renders the exit route map with disclosed tail routes", () => {
    const { container } = render(createElement(LiquidityStats, {
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
        [DEX_GLOBAL_KEY]: {
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
        } as DexLiquidityData,
      },
    }));

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
    render(createElement(LiquidityStats, {
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
        [DEX_GLOBAL_KEY]: {
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
        } as DexLiquidityData,
      },
    }));

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
});
