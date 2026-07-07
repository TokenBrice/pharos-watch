// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";

const {
  lazyViewportValues,
  nearViewportValues,
  longformScrollspyNavMock,
  useNearViewportMock,
  useStablecoinDetailViewModelMock,
} = vi.hoisted(() => ({
  lazyViewportValues: [] as boolean[],
  nearViewportValues: [] as boolean[],
  longformScrollspyNavMock: vi.fn(),
  useNearViewportMock: vi.fn(),
  useStablecoinDetailViewModelMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    const source = loader.toString();
    if (source.includes("ReservePanel")) {
      return function ReservePanelStub({
        reserves,
        onRetry,
        isFetching,
      }: {
        reserves?: { mode?: string } | null;
        onRetry?: () => Promise<unknown> | void;
        isFetching?: boolean;
      }) {
        return (
          <section id="reserves" data-testid="reserve-panel">
            <span>{reserves?.mode ?? "no-reserves"}</span>
            <button
              type="button"
              disabled={isFetching}
              onClick={() => {
                void onRetry?.();
              }}
            >
              Retry reserves
            </button>
          </section>
        );
      };
    }
    if (source.includes("ReportCardDetail")) {
      return function ReportCardDetailStub({ rightColumn }: { rightColumn?: ReactNode }) {
        return <div data-testid="report-card">{rightColumn}</div>;
      };
    }
    if (source.includes("FlowHistorySection")) {
      return function FlowHistorySectionStub() {
        return <div data-testid="flow-history-section" />;
      };
    }
    if (source.includes("FlowsSection")) {
      return function FlowsSectionStub() {
        return <div data-testid="flows-section" />;
      };
    }
    if (source.includes("BlacklistHistorySection")) {
      return function BlacklistHistorySectionStub() {
        return <div data-testid="blacklist-history-section" />;
      };
    }
    if (source.includes("BlacklistSection")) {
      return function BlacklistSectionStub() {
        return <div data-testid="blacklist-section" />;
      };
    }
    return function DynamicPlaceholder() {
      return <div data-testid="dynamic-detail-section" />;
    };
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-stablecoin-detail-view-model", () => ({
  useStablecoinDetailViewModel: useStablecoinDetailViewModelMock,
}));

vi.mock("@/hooks/use-near-viewport", () => ({
  useNearViewport: useNearViewportMock,
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: () => ({ data: { total: 0 } }),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: () => null,
}));

vi.mock("@/components/longform-scrollspy-nav", () => ({
  LongformScrollspyNav: (props: { className?: string; railLabel?: string; variant?: "banner" | "rail" }) => {
    longformScrollspyNavMock(props);
    return (
      <nav
        data-testid="scrollspy"
        data-rail-label={props.railLabel}
        data-variant={props.variant ?? "banner"}
        className={props.className}
      />
    );
  },
}));

vi.mock("@/components/stablecoin-detail/hero-card", () => ({
  HeroCard: () => <div data-testid="hero-card" />,
}));

vi.mock("@/components/stablecoin-detail/price-transparency-card", () => ({
  PriceTransparencyCard: () => <div data-testid="price-transparency-card" />,
}));

vi.mock("@/components/stablecoin-detail/redemption-backstop-card", () => ({
  RedemptionBackstopCard: ({ entry }: { entry: { stablecoinId: string } }) => (
    <section data-testid="redemption-backstop-card">{entry.stablecoinId}</section>
  ),
}));

vi.mock("@/components/ai-summary", () => ({
  AiSummary: () => null,
}));

vi.mock("@/components/coin-notice", () => ({
  CoinNotices: () => null,
}));

vi.mock("@/components/tape-for-coin-teaser", () => ({
  TapeForCoinTeaser: () => null,
}));

vi.mock("@/components/feedback-modal", () => ({
  FeedbackModal: () => null,
}));

vi.mock("@/components/exploit-notice-banner", () => ({
  ExploitNoticeBanner: () => null,
}));

vi.mock("@/components/stablecoin-detail/recent-blacklist-banner", () => ({
  RecentBlacklistBanner: () => null,
}));

vi.mock("@/components/stablecoin-detail/contagion-snapshot", () => ({
  // Render the `variantRelationshipCard` child so tests can still assert it
  // exists outside the overview section; suppress the inner contagion graph
  // which would otherwise pull in the live useReportCards query.
  ContagionSnapshot: ({ variantRelationshipCard }: { variantRelationshipCard?: import("react").ReactNode }) => (
    <div data-testid="contagion-snapshot-mock">{variantRelationshipCard}</div>
  ),
}));

function makeReadyViewModel(overrides: Record<string, unknown> = {}) {
  const coin = TRACKED_META_BY_ID.get("usds-sky")!;
  return {
    status: "ready" as const,
    id: coin.id,
    coin,
    summary: null,
    logoSrc: undefined,
    reportCard: null,
    reportCardUpdatedAt: null,
    variantParent: null,
    variantSiblings: [],
    childVariants: [TRACKED_META_BY_ID.get("susds-sky")!, TRACKED_META_BY_ID.get("stusds-sky")!],
    isVariant: false,
    hasVariants: true,
    coinData: {
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol,
      pegType: "peggedUSD",
      price: 1,
      circulating: { peggedUSD: 100 },
      circulatingPrevDay: { peggedUSD: 99 },
      circulatingPrevWeek: { peggedUSD: 98 },
      circulatingPrevMonth: { peggedUSD: 97 },
      chainCirculating: {},
      chains: ["ethereum"],
    },
    mcap: 100,
    supply: 100,
    prevDay: 99,
    prevWeek: 98,
    prevMonth: 97,
    performanceVsUsd1y: null,
    pegRef: 1,
    deviationBps: 0,
    gaugeDeviationBps: 0,
    isNavToken: false,
    pegScoreResult: null,
    consensusSources: [],
    agreeSources: [],
    dexPriceCheck: null,
    liquidityData: undefined,
    yieldRanking: null,
    hasYieldSection: false,
    stressSignal: null,
    redemptionBackstop: undefined,
    hasFlows: false,
    hasBlacklist: false,
    supplyHistory: [],
    earliestTrackingDate: null,
    reserves: null,
    reserveFetchError: null,
    refetchReserves: null,
    isFetchingReserves: false,
    supplyError: null,
    staleQueries: [],
    verdict: {
      archetype: "uncategorized",
      label: "Uncategorized",
    },
    mintAuthority: { status: "not-reviewed" as const },
    handleRetryAll: vi.fn(),
    ...overrides,
  };
}

describe("StablecoinDetailClient", () => {
  beforeEach(() => {
    lazyViewportValues.length = 0;
    nearViewportValues.length = 0;
    useNearViewportMock.mockReset();
    useNearViewportMock.mockImplementation((rootMargin?: string) => {
      const queue = rootMargin === "600px" ? nearViewportValues : lazyViewportValues;
      return {
        ref: { current: null },
        near: queue.shift() ?? true,
      };
    });
    useStablecoinDetailViewModelMock.mockReset();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());
    longformScrollspyNavMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders static profile content in the loading fallback", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue({ status: "loading" });

    const { container } = render(
      <StablecoinDetailClient
        id={coin.id}
        coin={coin}
        summary={null}
        staticCoin={buildStablecoinStaticMeta(coin)}
        staticProfileContent={<section data-testid="static-profile">Static stablecoin profile</section>}
      />,
    );

    const staticProfile = screen.getByTestId("static-profile");
    expect(staticProfile.textContent).toContain("Static stablecoin profile");
    expect(container.textContent).toContain("Loading research dossier");
  });

  it("passes near-viewport section gates into supplemental query controls", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    nearViewportValues.push(false, true, false);

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(useStablecoinDetailViewModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supplementalQueryControls: {
          flows: true,
          blacklist: true,
          reserves: false,
        },
      }),
    );
  });

  it("arms the flows query when only the overview zone is near", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    nearViewportValues.push(true, false, false);

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(useStablecoinDetailViewModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supplementalQueryControls: {
          flows: true,
          blacklist: false,
          reserves: true,
        },
      }),
    );
  });

  it("keeps supplemental query controls disabled before their sections are near", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    nearViewportValues.push(false, false, false);

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(useStablecoinDetailViewModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supplementalQueryControls: {
          flows: false,
          blacklist: false,
          reserves: false,
        },
      }),
    );
  });

  it("keeps flows and blacklist children behind their own lazy gates", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    nearViewportValues.push(true, true, true);
    lazyViewportValues.push(
      false, // Overview FlowsSection
      true, // DexLiquidityCard
      false, // Activity BlacklistSection
      true, // SafetyScoreHistorySection
      true, // DepegHistory
      true, // FlowHistorySection
      true, // BlacklistHistorySection
    );
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        hasFlows: true,
        hasBlacklist: true,
        blacklistSymbol: "USDT",
        supplyHistory: [{ date: "2026-01-01", mcap: 100, price: 1, supply: 100 }],
      }),
    );

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(screen.queryByTestId("flows-section")).toBeNull();
    expect(screen.queryByTestId("blacklist-section")).toBeNull();
    expect(screen.getByTestId("flow-history-section")).toBeTruthy();
    expect(screen.getByTestId("blacklist-history-section")).toBeTruthy();
  });

  it("renders the parent variants card outside the overview section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const overviewSections = container.querySelectorAll("#overview");
    expect(overviewSections).toHaveLength(1);
    expect(screen.getByText("Variants")).toBeTruthy();
    expect(overviewSections[0]?.contains(screen.getByText("Variants"))).toBe(false);
    expect(screen.getAllByText("Sky Savings USDS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Staked USDS").length).toBeGreaterThan(0);
  });

  it("uses one full-width sticky banner scrollspy so desktop sections keep the full content width", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const scrollspyNavs = screen.getAllByTestId("scrollspy");
    expect(scrollspyNavs).toHaveLength(1);
    expect(scrollspyNavs[0]?.dataset.variant).toBe("banner");
    expect(scrollspyNavs[0]?.dataset.railLabel).toBe("Jump to");
    expect(scrollspyNavs[0]?.className).toContain("lg:top-[calc(env(safe-area-inset-top)+3px+3.5rem+46px)]");
    expect(scrollspyNavs[0]?.className).toContain("lg:w-full");
    expect(scrollspyNavs[0]?.className).toContain("lg:[&>div]:justify-center");
    expect(scrollspyNavs[0]?.className).toContain("lg:[&_nav]:flex-none");
    expect(scrollspyNavs[0]?.className).not.toContain("lg:w-fit");
    expect(container.querySelector('aside[aria-label="Section navigation"]')).toBeNull();
    expect(longformScrollspyNavMock).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "rail" }));
  });

  it("renders the xl summary rail with in-flow copies owning the deep-link anchors", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const rail = container.querySelector('aside[aria-label="Coin summary rail"]');
    expect(rail).toBeTruthy();
    // Dual-rendered rail modules must never duplicate anchor ids: the in-flow
    // (below-xl) instance owns #price / #coin-timeline / #contracts.
    expect(container.querySelectorAll("#price").length).toBeLessThanOrEqual(1);
    expect(container.querySelectorAll("#coin-timeline")).toHaveLength(1);
    expect(container.querySelectorAll("#contracts").length).toBeLessThanOrEqual(1);
    expect(container.querySelectorAll("#price-transparency").length).toBeLessThanOrEqual(1);
  });

  it("renders reserve view in the overview stream when report-card data is unavailable", async () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const refetchReserves = vi.fn().mockResolvedValue({ status: "success" });
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        reportCard: null,
        reserves: {
          reserves: [{ name: "Curated reserve", pct: 100, risk: "low" }],
          estimated: false,
          mode: "curated-fallback",
        },
        refetchReserves,
        isFetchingReserves: true,
      }),
    );

    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const reservePanel = await screen.findByTestId("reserve-panel");
    const reportCardAnchor = container.querySelector("#report-card");
    expect(screen.queryByTestId("report-card")).toBeNull();
    expect(reservePanel.textContent).toContain("curated-fallback");
    expect(reportCardAnchor?.contains(reservePanel)).toBe(false);
    expect(screen.getByRole("button", { name: "Retry reserves" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the underlying asset card outside the overview section for variants", () => {
    const coin = TRACKED_META_BY_ID.get("susds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        id: coin.id,
        coin,
        variantParent: TRACKED_META_BY_ID.get("usds-sky")!,
        variantSiblings: [TRACKED_META_BY_ID.get("stusds-sky")!],
        childVariants: [],
        isVariant: true,
        hasVariants: false,
        coinData: {
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          pegType: "peggedUSD",
          price: 1.01,
          circulating: { peggedUSD: 100 },
          circulatingPrevDay: { peggedUSD: 99 },
          circulatingPrevWeek: { peggedUSD: 98 },
          circulatingPrevMonth: { peggedUSD: 97 },
          chainCirculating: {},
          chains: ["ethereum"],
        },
        isNavToken: true,
      }),
    );

    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const overviewSections = container.querySelectorAll("#overview");
    expect(overviewSections).toHaveLength(1);
    expect(screen.getByText("Underlying Asset")).toBeTruthy();
    expect(overviewSections[0]?.contains(screen.getByText("Underlying Asset"))).toBe(false);
    expect(screen.getAllByText("Sky Dollar").length).toBeGreaterThan(0);
  });

  it("uses the market data section for non-yield-bearing USD assets with supply history", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        supplyHistory: [{ date: "2026-01-01", mcap: 100, price: 1, supply: 100 }],
      }),
    );

    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(container.querySelector("#chart")).toBeNull();
    expect(screen.getAllByTestId("dynamic-detail-section").length).toBeGreaterThan(0);
  });

  it("keeps yield-bearing USD assets on the mcap chart instead of the peg chart", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const yieldBearingCoin = {
      ...coin,
      flags: {
        ...coin.flags,
        yieldBearing: true,
        navToken: false,
        pegCurrency: "USD" as const,
      },
    };
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        coin: yieldBearingCoin,
        isNavToken: false,
        supplyHistory: [{ date: "2026-01-01", mcap: 100, price: 1.01, supply: 99 }],
      }),
    );

    const { container } = render(
      <StablecoinDetailClient
        id={yieldBearingCoin.id}
        coin={yieldBearingCoin}
        summary={null}
        staticCoin={buildStablecoinStaticMeta(yieldBearingCoin)}
      />,
    );

    expect(container.querySelector("#chart")).toBeTruthy();
  });

  it("mounts redemption backstop data in the liquidity zone", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        redemptionBackstop: {
          stablecoinId: coin.id,
        },
      }),
    );

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    // Two instances render (liquidity zone + xl right rail); the in-flow
    // liquidity copy is the one wrapped in the #price section.
    const priceCards = screen.getAllByTestId("price-transparency-card");
    expect(priceCards).toHaveLength(2);
    const priceSection = priceCards
      .map((card) => card.closest("section#price"))
      .find((section) => section != null);
    expect(priceSection).toBeTruthy();
    const redemptionCard = screen.getByTestId("redemption-backstop-card");
    expect(redemptionCard.parentElement).toBe(priceSection?.parentElement);
  });

  it("keeps the liquidity price panel when redemption backstop data is absent", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        redemptionBackstop: undefined,
      }),
    );

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(screen.getAllByTestId("price-transparency-card").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("redemption-backstop-card")).toBeNull();
  });

  it("keeps redemption in the liquidity zone when price transparency data is absent", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        coinData: {
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          pegType: "peggedUSD",
          price: null,
          circulating: { peggedUSD: 100 },
          circulatingPrevDay: { peggedUSD: 99 },
          circulatingPrevWeek: { peggedUSD: 98 },
          circulatingPrevMonth: { peggedUSD: 97 },
          chainCirculating: {},
          chains: ["ethereum"],
        },
        dexPriceCheck: null,
        redemptionBackstop: {
          stablecoinId: coin.id,
        },
      }),
    );

    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(screen.queryByTestId("price-transparency-card")).toBeNull();
    const redemptionCard = screen.getByTestId("redemption-backstop-card");
    const liquiditySection = container.querySelector("#dex-liquidity");
    expect(liquiditySection?.parentElement?.contains(redemptionCard)).toBe(true);
  });

  it("omits the liquidity detail grid when price transparency and redemption data are absent", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        coinData: {
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          pegType: "peggedUSD",
          price: null,
          circulating: { peggedUSD: 100 },
          circulatingPrevDay: { peggedUSD: 99 },
          circulatingPrevWeek: { peggedUSD: 98 },
          circulatingPrevMonth: { peggedUSD: 97 },
          chainCirculating: {},
          chains: ["ethereum"],
        },
        dexPriceCheck: null,
        redemptionBackstop: undefined,
      }),
    );

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(screen.queryByTestId("price-transparency-card")).toBeNull();
    expect(screen.queryByTestId("redemption-backstop-card")).toBeNull();
  });
});
