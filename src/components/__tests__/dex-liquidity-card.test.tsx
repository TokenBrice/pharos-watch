// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DexLiquidityCard } from "@/components/liquidity/dex-liquidity-card";
import { ExitCapacityTrend, PoolSourceLabel, TvlTrendChart } from "@/components/liquidity/dex-liquidity-card-parts";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import type { DexExitRouteObservation } from "@shared/types/exit-route";
import type { DexLiquidityHistoryPoint, DexLiquidityPool } from "@shared/types/dex-liquidity";
import { summarizeDexVolumeWindow, type DexPoolVolumeObservationInput } from "@shared/lib/dex-volume-availability";
import { formatCurrency, formatUsdPriceAdaptive } from "@shared/lib/format";

function marketBreakdown(container: HTMLElement) {
  const details = Array.from(container.querySelectorAll("details")).find((node) =>
    node.textContent?.includes("Full market breakdown"),
  );
  if (!details) throw new Error("Full market breakdown disclosure not found");
  return details;
}

function openMarketBreakdown(container: HTMLElement) {
  const details = marketBreakdown(container);
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
  useDexLiquidityCoin: useDexLiquidityMock,
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

function makePools(count: number): DexLiquidityPool[] {
  return Array.from({ length: count }, (_, index) => ({
    project: index === 0 ? "curve" : `venue-${index}`,
    chain: index % 2 === 0 ? "ethereum" : "arbitrum",
    tvlUsd: 1_000_000 - index * 10_000,
    symbol: `POOL${index}`,
    volumeUsd1d: 25_000,
    poolType: "amm",
  }));
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

function measuredPoint(tvl: number, date?: number) {
  return makeHistoryPoint({
    tvl, date: date ?? 1_775_692_800, coverageClass: "primary",
    liquidityEvidenceClass: "measured", hasMeasuredLiquidityEvidence: true,
  });
}

function mockHistory(data: DexLiquidityHistoryPoint[]) {
  useDexLiquidityHistoryMock.mockReturnValue({ data, isLoading: false });
}

it("shows changes at a fixed sell size for external payouts and keeps missing and zero baselines distinct", () => {
  const route = {
    routeId: "external", routeFamily: "dex-amm", requestedNotionalUsd: 1_000_000, executableUsd: 3231.89,
    maxCostBps: 200, settlementHorizonSec: 300, evidenceKind: "reserve-based-amm-simulation",
    completionRatio: 0.003232, observedAt: 1_795_857_263, freshnessSeconds: 100, scoreEligible: true,
    confidence: "high", commonModeKeys: [], scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "pool", protocol: "curve" },
    output: { kind: "tracked-stablecoin", trackedAssetIds: ["frxusd-frax"], assetKeys: ["ethereum:frxusd"] },
  } satisfies DexExitRouteObservation;
  const liq = makeDexLiquidityData({ exitRouteObservations: [
    route, { ...route, routeId: "wrapped", output: { ...route.output, trackedAssetIds: ["strusd-tori"] } },
  ] });
  const renderTrend = (baselineUsd?: number) => <ExitCapacityTrend stablecoinId="trusd-tori" liq={{ ...liq,
    weeklyExitRouteBaselines: baselineUsd == null ? [] : [{ routeId: "external", observedAt: 1_795_266_731, executableUsd: baselineUsd }],
  }} />;
  const view = render(renderTrend(186_813.88));
  expect(screen.getByText(/-98.3% over 7d/)).toBeTruthy();
  expect(screen.getByText(/^frxusd$/i)).toBeTruthy();
  expect(screen.queryByText(/^strusd$/i)).toBeNull();
  view.rerender(renderTrend());
  expect(screen.getByText(/7d comparison unavailable/)).toBeTruthy();
  view.rerender(renderTrend(0));
  expect(screen.getByText(/7d percentage unavailable/)).toBeTruthy();
});

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
  function renderHistory(data: DexLiquidityHistoryPoint[]) {
    mockHistory(data);
    render(<TvlTrendChart stablecoinId="usdc-circle" />);
  }

  beforeEach(() => {
    useDexLiquidityHistoryMock.mockReset();
    areaChartMock.mockClear();
    areaMock.mockClear();
    tooltipMock.mockClear();
    chartReadyMock.mockReturnValue({ ref: vi.fn(), ready: true, width: 400, height: 128 });
  });

  it("renders mixed observed history with an unavailable gap instead of a zero liquidity collapse", () => {
    renderHistory([
      measuredPoint(1_000),
      makeHistoryPoint({ date: 1_775_779_200 }),
      makeHistoryPoint({ date: 1_775_865_600, tvl: 1_200, coverageClass: "mixed", liquidityEvidenceClass: "partial_measured", hasMeasuredLiquidityEvidence: true }),
    ]);

    expect(screen.getByRole("figure", { name: "TVL trend chart" })).toBeTruthy();
    const points = areaChartMock.mock.calls[0][0].data;
    expect(points.map((point: { tvl: number | null }) => point.tvl)).toEqual([1_000, null, 1_200]);
    expect(points[1]).toMatchObject({ coverageClass: "unobserved", liquidityEvidenceClass: "unobserved" });
    expect(areaMock.mock.calls[0][0].connectNulls).toBe(false);
    expect(tooltipMock.mock.calls[0][0].formatter(null)).toEqual(["Unavailable", "TVL"]);
    expect(tooltipMock.mock.calls[0][0].formatter(1_000)).toEqual([formatCurrency(1_000), "TVL"]);
  });

  it("keeps weak observed TVL visible without applying the trendworthiness floor", () => {
    renderHistory([
      makeHistoryPoint({ tvl: 100, coverageClass: "fallback", liquidityEvidenceClass: "observed_unmeasured" }),
      makeHistoryPoint({ tvl: 200, date: 1_775_779_200, coverageClass: "legacy", liquidityEvidenceClass: "observed_unmeasured" }),
    ]);
    expect(areaChartMock.mock.calls[0][0].data.map((point: { tvl: number | null }) => point.tvl)).toEqual([100, 200]);
  });

  it("does not turn unknown evidence or zero placeholders into measured history", () => {
    renderHistory([
      makeHistoryPoint({ tvl: 100, coverageClass: "primary", liquidityEvidenceClass: "measured" }),
      makeHistoryPoint({ date: 1_775_779_200, coverageClass: null, liquidityEvidenceClass: null }),
      makeHistoryPoint({ tvl: 900, date: 1_775_865_600, coverageClass: null, liquidityEvidenceClass: null }),
    ]);
    expect(areaChartMock.mock.calls[0][0].data.map((point: { tvl: number | null }) => point.tvl)).toEqual([100, null, null]);
  });
});

const mockCoin = (overrides: Parameters<typeof makeDexLiquidityData>[0], id = "usdc-circle") =>
  useDexLiquidityMock.mockReturnValue({ data: { [id]: makeDexLiquidityData(overrides) }, isLoading: false });

function renderCoin(stablecoinId = "usdc-circle") {
  return render(<DexLiquidityCard stablecoinId={stablecoinId} />);
}

function renderBreakdown(stablecoinId?: string) {
  const { container } = renderCoin(stablecoinId);
  openMarketBreakdown(container);
  return container;
}

describe("DexLiquidityCard", () => {
  beforeEach(() => {
    useDexLiquidityMock.mockReset();
    useDexLiquidityHistoryMock.mockReset();
    mockHistory([]);
    chartReadyMock.mockReturnValue({ ref: vi.fn(), ready: false, width: 0, height: 0 });
  });

  it.each([NaN, Infinity, -Infinity, null, -0.01, 1.01])("renders invalid HHI %s as unscored", (concentrationHhi) => {
    mockCoin({ concentrationHhi, poolCount: 1, totalTvlUsd: 100_000 });
    const container = renderBreakdown();
    expect(screen.getByText("Crowding not scored")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Concentration: (Low|Medium|High)/);
  });

  it.each([[0, "Low", "0%"], [0.18, "Medium", "18%"], [0.35, "High", "35%"]] as const)(
    "preserves the rated concentration display for %s",
    (concentrationHhi, label, percent) => {
      mockCoin({ concentrationHhi, poolCount: 1, totalTvlUsd: 100_000 });
      renderBreakdown();
      expect(screen.getByText(label).parentElement?.textContent).toBe(`Concentration: ${label}(${percent})`);
    },
  );

  it.each([0.0000553, 0.0000499])("renders sub-cent DEX-implied price %s with adaptive precision", (dexPriceUsd) => {
    mockCoin({ poolCount: 1, totalTvlUsd: 1_000_000, liquidityScore: 76, dexPriceUsd, dexDeviationBps: 0 });
    renderBreakdown();
    const price = screen.getByText("DEX-implied price").parentElement!.querySelector("span.text-lg")!;
    expect(price.textContent).toBe(`$${formatUsdPriceAdaptive(dexPriceUsd)}`);
  });

  it("labels directional balance with the dollars of retained TVL actually measured", () => {
    mockCoin({ totalTvlUsd: 5_147_040.81, balanceMeasuredTvlUsd: 1_882_952.77, weightedBalanceRatio: 0.9917,
      liquidityScore: 62, poolCount: 6, liquidityEvidenceClass: "observed_unmeasured", coverageClass: "mixed" }, "trusd-tori");
    renderBreakdown("trusd-tori");
    const balance = screen.getByText("Directional balance of measured pools").parentElement!.parentElement!;
    expect(balance.textContent).toContain("99%");
    expect(balance.textContent).toContain("Measured balances cover $1.883M of $5.147M retained TVL (36.6%)");
  });

  it.each([0, 100_000])("renders invalid coverage as unavailable even with TVL %s", (totalTvlUsd) => {
    mockCoin({
      totalTvlUsd, poolCount: 0, coverageClass: null, coverageConfidence: null,
      liquidityEvidenceClass: null, liquidityScore: null,
      unavailableReason: "invalid-coverage-evidence",
    });
    renderCoin();
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

    renderCoin();

    expect(screen.getByRole("alert").textContent).toContain("DEX liquidity data is temporarily unavailable");
  });

  it("keeps paused pool inventory visible and labels incomplete effective depth", () => {
    const [pool] = makePools(1);
    mockCoin({
      poolCount: 3, effectiveTvlUsd: 100_000, totalTvlUsd: 1_000_000,
      effectiveDepth: { coverage: "partial", amountUsd: 100_000, pausedPoolCount: 1, unknownPoolCount: 1 },
      topPools: [{ ...pool!, project: "fluid", extra: { fluidSwapStatus: {
        status: "paused", reason: "fluid-swaps-paused", checkedAtSec: 1_775_822_400, maxAgeSec: 3600,
        poolAddress: "0x97f32e5091d0e6aee24beb398e6592ae111dee9c",
      } } }],
    });
    const { rerender } = renderCoin();
    expect(screen.getByText(`≥ ${formatCurrency(100_000)}`)).toBeTruthy();
    expect(screen.getByText("Effective depth excludes 1 paused pool.")).toBeTruthy();
    expect(screen.getByText("Swap availability unverified for 1 pool.")).toBeTruthy();
    expect(screen.getByText("Swaps paused")).toBeTruthy();
    mockCoin({ poolCount: 2, totalTvlUsd: 500_000, effectiveTvlUsd: 0,
      effectiveDepth: { coverage: "unavailable", amountUsd: null, pausedPoolCount: 1, unknownPoolCount: 1 } });
    rerender(<DexLiquidityCard stablecoinId="usdc-circle" />);
    expect(screen.getByText("Effective liquidity").nextElementSibling?.textContent).toBe("—");
    expect(screen.getByText(/Liquidity Score is unrated because swap availability/)).toBeTruthy();
  });

  it("renders unavailable 7d volume as an em dash", () => {
    mockCoin({
      totalVolume24hUsd: 2_890_000,
      totalVolume7dUsd: null,
      poolCount: 1,
      chainCount: 1,
    }, "gusd-gate");

    const { container } = renderCoin("gusd-gate");
    const sevenDayLabel = screen.getAllByText("7d volume")[0];

    expect(sevenDayLabel.nextElementSibling?.textContent).toBe("—");
    expect(container.textContent).toContain("$2.89M");
  });

  it("renders an explicit unobserved-history state instead of a zero-value chart for unrated assets", () => {
    mockCoin({
      // Coin is observed (has a pool) but unrated (liquidityScore null); the
      // card still renders and surfaces the unrated/no-direct-market notice.
      poolCount: 1,
      totalTvlUsd: 1_000,
    }, "usdk-kast");
    mockHistory([makeHistoryPoint(), makeHistoryPoint({ date: 1_775_779_200 })]);

    const { container } = renderCoin("usdk-kast");

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

  describe("pool text retention", () => {
    function poolTables(container: HTMLElement) {
      return container.querySelectorAll('[data-testid="dex-liquidity-top-pools-table"]');
    }

    function trendCharts(container: HTMLElement) {
      return container.querySelectorAll('[role="figure"][aria-label="TVL trend chart"]');
    }

    function renderCard({ poolCount = 6, pools = makePools(6) }: { poolCount?: number; pools?: DexLiquidityPool[] } = {}) {
      mockCoin({ poolCount, totalTvlUsd: 1_000_000, topPools: pools });
      mockHistory([measuredPoint(1_000), measuredPoint(1_200, 1_775_779_200)]);
      return renderCoin();
    }

    it("keeps the bounded pool table mounted inside the closed fold without mounting the chart", () => {
      const { container } = renderCard();
      const details = marketBreakdown(container);

      expect(details.open).toBe(false);
      expect(poolTables(container)).toHaveLength(1);
      expect(poolTables(container)[0]!.textContent).toContain("POOL0");
      expect(poolTables(container)[0]!.textContent).toContain("(curve)");
      expect(poolTables(container)[0]!.querySelectorAll("tbody tr")).toHaveLength(5);
      expect(container.textContent).toContain("Top 5 of 6 pools");
      expect(useDexLiquidityHistoryMock).not.toHaveBeenCalled();
      expect(trendCharts(container)).toHaveLength(0);
    });

    it("mounts one table and one chart on first open and keeps both after closing", () => {
      const { container } = renderCard();
      const details = marketBreakdown(container);

      openMarketBreakdown(container);
      expect(useDexLiquidityHistoryMock).toHaveBeenCalledTimes(1);
      expect(poolTables(container)).toHaveLength(1);
      expect(trendCharts(container)).toHaveLength(1);
      expect(poolTables(container)[0]!.querySelectorAll("tbody tr")).toHaveLength(5);

      details.open = false;
      fireEvent(details, new Event("toggle", { bubbles: false }));
      expect(poolTables(container)).toHaveLength(1);
      expect(trendCharts(container)).toHaveLength(1);
    });

    it("orders the open fold as diagnostics, then the pool table, then the TVL chart", () => {
      const { container } = renderCard();
      openMarketBreakdown(container);

      const order = Array.from(
        marketBreakdown(container).querySelectorAll(
          '[data-testid="dex-liquidity-top-pools-table"], [role="figure"][aria-label="TVL trend chart"]',
        ),
      );
      expect(order.map((node) => node.getAttribute("data-testid") ?? node.getAttribute("aria-label"))).toEqual([
        "dex-liquidity-top-pools-table",
        "TVL trend chart",
      ]);
    });

    it("renders sub-cent pool prices with the same magnitude-based precision as the header", () => {
      const [pool] = makePools(1);
      const { container } = renderCard({ poolCount: 1, pools: [{ ...pool!, price: 0.000061 }] });
      expect(poolTables(container)[0]!.textContent).toContain("$0.000061");
      expect(poolTables(container)[0]!.textContent).not.toContain("$0.0001");
    });

    it("states a reviewed LP lock as a pool fact and keeps its proof in the fold", () => {
      const [pool] = makePools(1);
      const holder = "0xbddab785b306bcd9fb056da189615cc8ece1d823";
      const permanentLiquidity = { lpShare: 0.8901, chain: "ethereum", lpToken: "0x1", holder, proof: "no-call-bytecode", verifiedAtBlock: 1 };
      const { container } = renderCard({ poolCount: 1, pools: [{ ...pool!, tvlUsd: 4e6, extra: { organicFraction: 1, permanentLiquidity } }] });
      expect(container.textContent).toContain("Permanent liquidity: 89% of the POOL0 pool on Curve, about $3.56M, can never be withdrawn.");
      expect(poolTables(container)[0]!.textContent).toContain("89% permanent");
      expect(marketBreakdown(container).querySelector(`a[href$="/address/${holder}"]`)?.textContent).toBe("0xbdda...d823");
    });

    it("labels five displayed rows from the authoritative pool count rather than the sliced list", () => {
      const { container } = renderCard({ poolCount: 9 });
      expect(poolTables(container)[0]!.querySelectorAll("tbody tr")).toHaveLength(5);
      expect(container.textContent).toContain("Top 5 of 9 pools");
    });

    it("renders no pool table or label when no pools were admitted", () => {
      const { container } = renderCard({ poolCount: 1, pools: [] });
      expect(poolTables(container)).toHaveLength(0);
      expect(container.textContent).not.toContain("Top pools");
      expect(container.textContent).not.toMatch(/\d+ of \d+ pools/);
    });
  });

  describe("DEC-19 volume availability", () => {
    const asOfSec = 1_790_000_000;
    const clock = { asOfSec, maxObservationAgeSec: 86_400 };
    const fresh = (volumeUsd: number | null): DexPoolVolumeObservationInput => ({ volumeUsd, observedAtSec: asOfSec - 600 });
    const aged: DexPoolVolumeObservationInput = { volumeUsd: 50_000, observedAtSec: asOfSec - 180 * 3600 };

    function renderWindows(pools: DexPoolVolumeObservationInput[], overrides: Parameters<typeof makeDexLiquidityData>[0] = {}) {
      const day = summarizeDexVolumeWindow(pools, "24h", clock);
      const week = summarizeDexVolumeWindow(pools, "7d", clock);
      mockCoin({
        totalTvlUsd: 1_000_000,
        poolCount: pools.length,
        chainCount: 1,
        liquidityScore: 60,
        totalVolume24hUsd: day.measuredUsd,
        totalVolume7dUsd: week.measuredUsd,
        volume24hAvailability: day.availability,
        volume7dAvailability: week.availability,
        ...overrides,
      });
      renderCoin();
      return ["24h volume", "7d volume"].map((label) => {
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
      ["stale", [aged], "Stale observations"],
    ] as const)("renders %s 24h/7d windows as a dash with a labelled detail", (_name, pools, detail) => {
      expect(renderWindows([...pools])).toEqual([
        { value: "—", detail },
        { value: "—", detail },
      ]);
    });

    it("headlines a partial window's lower bound with a coverage qualifier, never a bare dash", () => {
      // The "≥" is glued to its figure, so a narrow column cannot wrap it away.
      const bound = { value: `≥\u00a0${formatCurrency(40_000)}`, detail: "Partial coverage" };
      expect(renderWindows([fresh(40_000), fresh(null)], {
        scoreComponents: { tvlDepth: 89, volumeActivity: 72, poolQuality: 60, durability: 70, pairDiversity: 100 },
      })).toEqual([bound, bound]);
      // The verdict names components in the breakdown's own casing.
      expect(screen.getByText("Diversity 100 and TVL Depth 89 carry the score; Pool Quality 60 is the softest.")).toBeTruthy();
    });

    it("suppresses a zero partial lower bound in favour of the completeness label", () => {
      expect(renderWindows([fresh(0), fresh(null)])).toEqual([
        { value: "—", detail: "Partial coverage" },
        { value: "—", detail: "Partial coverage" },
      ]);
    });

    it("explains an activity NR instead of claiming no direct DEX market", () => {
      renderWindows([fresh(40_000), fresh(null)], {
        liquidityScore: null,
        scoreComponents: { tvlDepth: 70, volumeActivity: null, poolQuality: 60, durability: 50, pairDiversity: 10 },
      });
      expect(screen.getByText(/^Liquidity Score is not rated:/)).toBeTruthy();
      expect(screen.queryByText("No observed direct DEX market for this token in the current pipeline.")).toBeNull();
      // Valid components stay visible beside the unrated activity bar; the
      // notice says why, so no header pill repeats it, and the bar's value is a labelled dash.
      expect(screen.getByText("Score breakdown")).toBeTruthy();
      expect(screen.queryByText("Not rated")).toBeNull();
      expect(screen.getByLabelText("Not rated").textContent).toBe("–");
      expect(screen.queryByText("NR")).toBeNull();
    });
  });
});
