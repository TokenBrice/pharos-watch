// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DexLiquidityCard } from "@/components/dex-liquidity-card";
import { PoolSourceLabel, TvlTrendChart } from "@/components/dex-liquidity-card-parts";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import type { DexLiquidityHistoryPoint } from "@shared/types";
import { summarizeDexVolumeWindow, type DexPoolVolumeObservationInput } from "@shared/lib/dex-volume-availability";
import { formatCurrency } from "@shared/lib/format";

/** The market-breakdown fold defers charts/tables until first open. */
function openMarketBreakdown(container: HTMLElement) {
  const details = Array.from(container.querySelectorAll("details")).find((node) =>
    node.textContent?.includes("Full market breakdown"),
  );
  if (!details) throw new Error("Full market breakdown disclosure not found");
  details.open = true;
  fireEvent(details, new Event("toggle", { bubbles: false }));
}


const { useDexLiquidityMock, useDexLiquidityHistoryMock, chartReadyMock, areaChartMock, areaMock, tooltipMock } = vi.hoisted(() => ({
  useDexLiquidityMock: vi.fn(),
  useDexLiquidityHistoryMock: vi.fn(),
  chartReadyMock: vi.fn(),
  areaChartMock: vi.fn(),
  areaMock: vi.fn(),
  tooltipMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidity: useDexLiquidityMock,
  useDexLiquidityHistory: useDexLiquidityHistoryMock,
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: chartReadyMock,
}));

vi.mock("recharts", () => ({
  AreaChart: (props: { data: unknown[]; children: ReactNode }) => {
    areaChartMock(props);
    return <div>{props.children}</div>;
  },
  Area: (props: unknown) => { areaMock(props); return null; },
  Tooltip: (props: unknown) => { tooltipMock(props); return null; },
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
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

describe("PoolSourceLabel", () => {
  it.each([
    { count: 1, sources: null, expected: "from 1 DEX price source" },
    { count: 2, sources: [{ protocol: "curve" }], expected: "from 2 Curve price sources" },
  ])("labels $count observations as price sources rather than pools", ({ count, sources, expected }) => {
    render(<PoolSourceLabel count={count} tvl={null} priceSources={sources} />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

});

describe("TvlTrendChart", () => {
  beforeEach(() => {
    useDexLiquidityHistoryMock.mockReset();
    areaChartMock.mockClear();
    areaMock.mockClear();
    tooltipMock.mockClear();
    chartReadyMock.mockReturnValue({ ref: vi.fn(), ready: true, width: 400, height: 128 });
  });

  it("renders mixed observed history with an unavailable gap instead of a zero liquidity collapse", () => {
    useDexLiquidityHistoryMock.mockReturnValue({
      isLoading: false,
      data: [
        makeHistoryPoint({ tvl: 1_000, coverageClass: "primary", liquidityEvidenceClass: "measured", hasMeasuredLiquidityEvidence: true }),
        makeHistoryPoint({ date: 1_775_779_200 }),
        makeHistoryPoint({ date: 1_775_865_600, tvl: 1_200, coverageClass: "mixed", liquidityEvidenceClass: "partial_measured", hasMeasuredLiquidityEvidence: true }),
      ],
    });
    render(<TvlTrendChart stablecoinId="usdc-circle" />);

    expect(screen.getByRole("figure", { name: "TVL trend chart" })).toBeTruthy();
    const points = areaChartMock.mock.calls[0][0].data;
    expect(points.map((point: { tvl: number | null }) => point.tvl)).toEqual([1_000, null, 1_200]);
    expect(points[1]).toMatchObject({ coverageClass: "unobserved", liquidityEvidenceClass: "unobserved" });
    expect(areaMock.mock.calls[0][0].connectNulls).toBe(false);
    expect(tooltipMock.mock.calls[0][0].formatter(null)).toEqual(["Unavailable", "TVL"]);
    expect(tooltipMock.mock.calls[0][0].formatter(1_000)).toEqual([formatCurrency(1_000), "TVL"]);
  });

  it("keeps weak observed TVL visible without applying the trendworthiness floor", () => {
    useDexLiquidityHistoryMock.mockReturnValue({
      isLoading: false,
      data: [
        makeHistoryPoint({ tvl: 100, coverageClass: "fallback", liquidityEvidenceClass: "observed_unmeasured" }),
        makeHistoryPoint({ tvl: 200, date: 1_775_779_200, coverageClass: "legacy", liquidityEvidenceClass: "observed_unmeasured" }),
      ],
    });
    render(<TvlTrendChart stablecoinId="usdc-circle" />);
    expect(areaChartMock.mock.calls[0][0].data.map((point: { tvl: number | null }) => point.tvl)).toEqual([100, 200]);
  });

  it("does not turn unknown evidence or zero placeholders into measured history", () => {
    useDexLiquidityHistoryMock.mockReturnValue({
      isLoading: false,
      data: [
        makeHistoryPoint({ tvl: 100, coverageClass: "primary", liquidityEvidenceClass: "measured" }),
        makeHistoryPoint({ date: 1_775_779_200, coverageClass: null, liquidityEvidenceClass: null }),
        makeHistoryPoint({ tvl: 900, date: 1_775_865_600, coverageClass: null, liquidityEvidenceClass: null }),
      ],
    });
    render(<TvlTrendChart stablecoinId="usdc-circle" />);
    expect(areaChartMock.mock.calls[0][0].data.map((point: { tvl: number | null }) => point.tvl)).toEqual([100, null, null]);
  });
});

describe("DexLiquidityCard", () => {
  beforeEach(() => {
    useDexLiquidityMock.mockReset();
    useDexLiquidityHistoryMock.mockReset();
    chartReadyMock.mockReturnValue({ ref: vi.fn(), ready: false, width: 0, height: 0 });
  });

  it.each([0, 100_000])("renders invalid coverage as unavailable even with TVL %s", (totalTvlUsd) => {
    useDexLiquidityMock.mockReturnValue({
      data: { "usdc-circle": makeDexLiquidityData({
        totalTvlUsd, poolCount: 0, coverageClass: null, coverageConfidence: null,
        liquidityEvidenceClass: null, liquidityScore: null,
        unavailableReason: "invalid-coverage-evidence",
      }) },
      isLoading: false,
    });
    render(<DexLiquidityCard stablecoinId="usdc-circle" />);
    expect(screen.getByText("Unavailable coverage")).toBeTruthy();
    expect(screen.getByText("DEX coverage evidence is unavailable (invalid-coverage-evidence).")).toBeTruthy();
    expect(screen.queryByText("No observed direct DEX market for this token in the current pipeline.")).toBeNull();
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

  it("renders unavailable 7d volume as an em dash", () => {
    useDexLiquidityMock.mockReturnValue({
      data: {
        "gusd-gate": makeDexLiquidityData({
          totalVolume24hUsd: 2_890_000,
          totalVolume7dUsd: null,
          poolCount: 1,
          chainCount: 1,
        }),
      },
      isLoading: false,
    });
    useDexLiquidityHistoryMock.mockReturnValue({
      data: [],
      isLoading: false,
    });

    const { container } = render(<DexLiquidityCard stablecoinId="gusd-gate" />);
    const sevenDayLabel = screen.getAllByText("7d Volume")[0];

    expect(sevenDayLabel.nextElementSibling?.textContent).toBe("—");
    expect(container.textContent).toContain("$2.89M");
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

    const { container } = render(<DexLiquidityCard stablecoinId="usdk-kast" />);

    expect(screen.getByText("No observed direct DEX market for this token in the current pipeline.")).toBeTruthy();
    openMarketBreakdown(container);
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

  describe("DEC-19 volume availability", () => {
    const asOfSec = 1_790_000_000;
    const clock = { asOfSec, maxObservationAgeSec: 86_400 };
    const fresh = (volumeUsd: number | null): DexPoolVolumeObservationInput => ({ volumeUsd, observedAtSec: asOfSec - 600 });
    const aged: DexPoolVolumeObservationInput = { volumeUsd: 50_000, observedAtSec: asOfSec - 180 * 3600 };

    function renderWindows(pools: DexPoolVolumeObservationInput[], overrides: Parameters<typeof makeDexLiquidityData>[0] = {}) {
      const day = summarizeDexVolumeWindow(pools, "24h", clock);
      const week = summarizeDexVolumeWindow(pools, "7d", clock);
      useDexLiquidityMock.mockReturnValue({
        data: {
          "usdc-circle": makeDexLiquidityData({
            totalTvlUsd: 1_000_000,
            poolCount: pools.length,
            chainCount: 1,
            liquidityScore: 60,
            totalVolume24hUsd: day.measuredUsd,
            totalVolume7dUsd: week.measuredUsd,
            volume24hAvailability: day.availability,
            volume7dAvailability: week.availability,
            ...overrides,
          }),
        },
        isLoading: false,
      });
      useDexLiquidityHistoryMock.mockReturnValue({ data: [], isLoading: false });
      render(<DexLiquidityCard stablecoinId="usdc-circle" />);
      return ["24h Volume", "7d Volume"].map((label) => {
        const value = screen.getAllByText(label)[0]!.nextElementSibling!;
        return { value: value.textContent, detail: value.nextElementSibling?.textContent ?? null };
      });
    }

    it("renders a complete measured zero as a measured 0", () => {
      const windows = renderWindows([fresh(0), fresh(0)]);
      expect(windows).toEqual([
        { value: formatCurrency(0), detail: null },
        { value: formatCurrency(0), detail: null },
      ]);
    });

    it.each([
      ["all-missing", [fresh(null), fresh(null)], "Not observed"],
      ["mixed", [fresh(40_000), fresh(null)], `Partial ≥ ${formatCurrency(40_000)}`],
      ["stale", [aged], "Stale observations"],
    ] as const)("renders %s 24h/7d windows as a dash with a labelled detail", (_name, pools, detail) => {
      expect(renderWindows([...pools])).toEqual([
        { value: "—", detail },
        { value: "—", detail },
      ]);
    });

    it("explains an activity NR instead of claiming no direct DEX market", () => {
      renderWindows([fresh(40_000), fresh(null)], {
        liquidityScore: null,
        scoreComponents: { tvlDepth: 70, volumeActivity: null, poolQuality: 60, durability: 50, pairDiversity: 10 },
      });
      expect(screen.getByText(/^Liquidity Score is not rated:/)).toBeTruthy();
      expect(screen.queryByText("No observed direct DEX market for this token in the current pipeline.")).toBeNull();
      // Valid components stay visible beside the NR activity bar (header pill + bar).
      expect(screen.getByText("Score breakdown")).toBeTruthy();
      expect(screen.getAllByText("NR").length).toBeGreaterThanOrEqual(2);
    });
  });
});
