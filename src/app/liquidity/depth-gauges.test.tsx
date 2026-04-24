// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepthGauges } from "./depth-gauges";
import { DEX_GLOBAL_KEY, type DexLiquidityData, type LiquidityCoverageClass } from "@shared/types";
import type { LiquidityRow } from "@/components/liquidity-table";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) =>
    createElement("img", { ...props, alt: props.alt ?? "" }),
}));

afterEach(() => cleanup());

function makeLiq(overrides: Partial<DexLiquidityData>): DexLiquidityData {
  return {
    totalTvlUsd: 1_000_000,
    totalVolume24hUsd: 100_000,
    totalVolume7dUsd: 500_000,
    poolCount: 3,
    pairCount: 3,
    chainCount: 2,
    protocolTvl: {},
    chainTvl: {},
    topPools: [],
    liquidityScore: 70,
    concentrationHhi: 0.3,
    depthStability: null,
    tvlChange24h: null,
    tvlChange7d: 1.5,
    updatedAt: Date.now(),
    dexPriceUsd: 1,
    dexDeviationBps: null,
    priceSourceCount: null,
    priceSourceTvl: null,
    priceSources: null,
    effectiveTvlUsd: 900_000,
    avgPoolStress: null,
    weightedBalanceRatio: 0.9,
    organicFraction: 0.8,
    durabilityScore: null,
    coverageClass: "primary" as LiquidityCoverageClass,
    coverageConfidence: 0.9,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    trendworthy: true,
    sourceMix: {},
    balanceMeasuredTvlUsd: 900_000,
    organicMeasuredTvlUsd: 900_000,
    scoreComponents: null,
    lockedLiquidityPct: null,
    methodologyVersion: "v1",
    ...overrides,
  };
}

function makeRow(id: string, score: number | null, vol: number, organic: number | null): LiquidityRow {
  return {
    meta: {
      id,
      symbol: id.toUpperCase(),
      name: `Coin ${id}`,
      flags: { pegCurrency: "USD" as const },
    } as LiquidityRow["meta"],
    liq: makeLiq({ liquidityScore: score, totalVolume24hUsd: vol, organicFraction: organic }),
  };
}

describe("DepthGauges", () => {
  it("renders the hero reservoir and gauges, sorted by depth descending", () => {
    const rows = [
      makeRow("a", 40, 10_000, 0.5),
      makeRow("b", 80, 100, 0.9),
      makeRow("c", 60, 9_000_000, 0.1),
    ];
    render(createElement(DepthGauges, {
      rows,
      unratedRows: [],
      liquidityMap: { [DEX_GLOBAL_KEY]: makeLiq({}) },
      logos: {},
      sort: "depth" as const,
      onSortChange: () => {},
      onSelect: () => {},
    }));

    expect(screen.getByText("Global Reservoir")).toBeTruthy();
    const labels = screen.getAllByText(/^(A|B|C)$/);
    expect(labels.map((el) => el.textContent)).toEqual(["B", "C", "A"]);
  });

  it("renders a Dry Docks row when unrated rows exist", () => {
    render(createElement(DepthGauges, {
      rows: [],
      unratedRows: [makeRow("x", null, 0, null)],
      liquidityMap: {},
      logos: {},
      sort: "depth" as const,
      onSortChange: () => {},
      onSelect: () => {},
    }));
    expect(screen.getByText("Dry Docks")).toBeTruthy();
    expect(screen.getByText("X")).toBeTruthy();
  });

  it("fires onSelect with the coin id when a gauge is clicked", () => {
    const onSelect = vi.fn();
    render(createElement(DepthGauges, {
      rows: [makeRow("a", 40, 10_000, 0.5)],
      unratedRows: [],
      liquidityMap: {},
      logos: {},
      sort: "depth" as const,
      onSortChange: () => {},
      onSelect,
    }));
    fireEvent.click(screen.getByRole("button", { name: /A/ }));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("sorts by volume when sort=volume", () => {
    const rows = [
      makeRow("lowvol", 95, 100, 0.9),
      makeRow("hivol", 40, 10_000_000, 0.1),
    ];
    render(createElement(DepthGauges, {
      rows,
      unratedRows: [],
      liquidityMap: {},
      logos: {},
      sort: "volume" as const,
      onSortChange: () => {},
      onSelect: () => {},
    }));
    const labels = screen.getAllByText(/^(HIVOL|LOWVOL)$/);
    expect(labels[0]?.textContent).toBe("HIVOL");
  });
});
