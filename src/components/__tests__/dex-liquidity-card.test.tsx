// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DexLiquidityCard } from "@/components/dex-liquidity-card";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import type { DexLiquidityHistoryPoint, DexLiquidityPool } from "@shared/types";

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
  MethodologyHint: ({ children }: { children?: ReactNode }) => <>{children ?? null}</>,
  MethodologyTriggerButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

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

  it("renders unavailable instead of hiding the module when the query fails", () => {
    useDexLiquidityMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("liquidity failed"),
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(<DexLiquidityCard stablecoinId="usdc-circle" />);

    expect(screen.getByRole("alert").textContent).toContain("DEX liquidity data is temporarily unavailable");
  });

  it("promotes effective liquidity above total AMM liquidity in the overview metrics", () => {
    useDexLiquidityMock.mockReturnValue({
      data: {
        "usdc-circle": makeDexLiquidityData({
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

    expect(screen.getAllByText("DEX market liquidity").length).toBeGreaterThan(0);
    expect(screen.getByText("Mixed coverage")).toBeTruthy();
    expect(
      screen.getByText("Aggregate DEX market score; not a single-route execution test."),
    ).toBeTruthy();
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
        "usdk-kast": makeDexLiquidityData({
          // Coin is observed (has a pool) but unrated (liquidityScore null); the
          // card still renders and surfaces the unrated/no-direct-market notice.
          poolCount: 1,
          totalTvlUsd: 1_000,
        }),
      },
      isLoading: false,
    });
    useDexLiquidityHistoryMock.mockReturnValue({
      data: [makeHistoryPoint(), makeHistoryPoint({ date: 1_775_779_200 })],
      isLoading: false,
    });

    render(<DexLiquidityCard stablecoinId="usdk-kast" />);

    expect(screen.getByText("No observed direct DEX market for this token in the current pipeline.")).toBeTruthy();
    expect(
      screen.getByText(
        "Pharos tracked the last 90 days but found no direct-token DEX liquidity evidence for this asset.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Related-asset liquidity is intentionally not merged into the canonical Liquidity Score."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("TVL trend chart")).toBeNull();
  });

  it("renders top pools through the shared embedded table frame", () => {
    const topPool: DexLiquidityPool = {
      project: "curve",
      chain: "Ethereum",
      tvlUsd: 1_250_000,
      symbol: "USDC/USDT",
      volumeUsd1d: 420_000,
      poolType: "stable",
      price: 0.9998,
      extra: {
        balanceRatio: 0.96,
        organicFraction: 0.82,
        feeTier: 100,
        stressIndex: 12,
      },
    };
    useDexLiquidityMock.mockReturnValue({
      data: {
        "usdc-circle": makeDexLiquidityData({
          totalTvlUsd: 1_250_000,
          effectiveTvlUsd: 1_250_000,
          totalVolume24hUsd: 420_000,
          totalVolume7dUsd: 2_500_000,
          poolCount: 1,
          chainCount: 1,
          topPools: [topPool],
          coverageClass: "primary",
          liquidityEvidenceClass: "measured",
          hasMeasuredLiquidityEvidence: true,
        }),
      },
      isLoading: false,
    });
    useDexLiquidityHistoryMock.mockReturnValue({
      data: [],
      isLoading: false,
    });

    render(<DexLiquidityCard stablecoinId="usdc-circle" />);

    const shell = screen.getByTestId("dex-liquidity-top-pools-table");
    const table = screen.getByRole("table", { name: "Top DEX liquidity pools" });

    expect(shell.getAttribute("data-table-id")).toBe("dex-liquidity-top-pools");
    expect(shell.className).toContain("pharos-density-compact");
    expect(table.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
    expect(table.getAttribute("data-slot")).toBe("table");
    expect(screen.getByText("USDC/USDT")).toBeTruthy();
  });
});
