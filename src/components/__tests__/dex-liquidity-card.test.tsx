// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DexLiquidityCard } from "@/components/dex-liquidity-card";
import type { DexLiquidityData, DexLiquidityHistoryPoint } from "@shared/types";

const { useDexLiquidityMock, useDexLiquidityHistoryMock } = vi.hoisted(() => ({
  useDexLiquidityMock: vi.fn(),
  useDexLiquidityHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidity: useDexLiquidityMock,
  useDexLiquidityHistory: useDexLiquidityHistoryMock,
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({
    ref: vi.fn(),
    ready: false,
    width: 0,
    height: 0,
  }),
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
  MethodologyCardActions: () => null,
}));

function makeLiquidityData(overrides: Partial<DexLiquidityData> = {}): DexLiquidityData {
  return {
    totalTvlUsd: 0,
    totalVolume24hUsd: 0,
    totalVolume7dUsd: 0,
    poolCount: 0,
    pairCount: 0,
    chainCount: 0,
    protocolTvl: {},
    chainTvl: {},
    topPools: [],
    liquidityScore: null,
    concentrationHhi: null,
    depthStability: null,
    tvlChange24h: null,
    tvlChange7d: null,
    updatedAt: 1_775_822_400,
    dexPriceUsd: null,
    dexDeviationBps: null,
    priceSourceCount: null,
    priceSourceTvl: null,
    priceSources: null,
    effectiveTvlUsd: 0,
    avgPoolStress: null,
    weightedBalanceRatio: null,
    organicFraction: null,
    durabilityScore: null,
    coverageClass: "unobserved",
    coverageConfidence: 0,
    liquidityEvidenceClass: "unobserved",
    hasMeasuredLiquidityEvidence: false,
    trendworthy: false,
    sourceMix: {},
    balanceMeasuredTvlUsd: 0,
    organicMeasuredTvlUsd: 0,
    scoreComponents: null,
    methodologyVersion: "5.3",
    ...overrides,
  };
}

function makeHistoryPoint(overrides: Partial<DexLiquidityHistoryPoint> = {}): DexLiquidityHistoryPoint {
  return {
    tvl: 0,
    volume24h: 0,
    score: null,
    date: 1_775_692_800,
    coverageClass: "unobserved",
    coverageConfidence: 0,
    liquidityEvidenceClass: "unobserved",
    hasMeasuredLiquidityEvidence: false,
    trendworthy: false,
    methodologyVersion: "5.3",
    ...overrides,
  };
}

describe("DexLiquidityCard", () => {
  beforeEach(() => {
    useDexLiquidityMock.mockReset();
    useDexLiquidityHistoryMock.mockReset();
  });

  it("promotes effective liquidity above total AMM liquidity in the overview metrics", () => {
    useDexLiquidityMock.mockReturnValue({
      data: {
        "usdc-circle": makeLiquidityData({
          totalTvlUsd: 10_200_000,
          effectiveTvlUsd: 910_710,
          totalVolume24hUsd: 265_010,
          totalVolume7dUsd: 663_820,
          poolCount: 13,
          chainCount: 2,
          liquidityScore: 40,
          coverageClass: "mixed",
          liquidityEvidenceClass: "partial_measured",
          hasMeasuredLiquidityEvidence: true,
          balanceMeasuredTvlUsd: 1_224_000,
          tvlChange24h: -14.3,
          tvlChange7d: -12.3,
        }),
      },
      isLoading: false,
    });
    useDexLiquidityHistoryMock.mockReturnValue({
      data: [],
      isLoading: false,
    });

    render(<DexLiquidityCard stablecoinId="usdc-circle" />);

    const effectiveLabel = screen.getByText("Effective Liquidity");
    const effectiveValue = screen.getByText("$910.71K");
    const totalAmmLabel = screen.getByText("Total AMM Liquidity TVL");
    const totalAmmValue = screen.getByText("$10.20M");

    expect(effectiveLabel.compareDocumentPosition(totalAmmLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(effectiveValue.compareDocumentPosition(totalAmmValue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders an explicit unobserved-history state instead of a zero-value chart for unrated assets", () => {
    useDexLiquidityMock.mockReturnValue({
      data: {
        "usdk-kast": makeLiquidityData(),
      },
      isLoading: false,
    });
    useDexLiquidityHistoryMock.mockReturnValue({
      data: [
        makeHistoryPoint(),
        makeHistoryPoint({ date: 1_775_779_200 }),
      ],
      isLoading: false,
    });

    render(<DexLiquidityCard stablecoinId="usdk-kast" />);

    expect(screen.getByText("No observed direct DEX market for this token in the current pipeline.")).toBeTruthy();
    expect(
      screen.getByText("Pharos tracked the last 90 days but found no direct-token DEX liquidity evidence for this asset."),
    ).toBeTruthy();
    expect(
      screen.getByText("Related-asset liquidity is intentionally not merged into the canonical Liquidity Score."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("TVL trend chart")).toBeNull();
  });
});
