// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContagionSnapshotMock,
  createDepegEventsMock,
  createHeroCardMock,
  createLogosMock,
  createNextLinkMock,
  createNoopComponentMock,
  createStablecoinLogoMock,
  createViewModelMock,
  makeFrozenViewModel,
  makeReadyViewModel,
  obituary,
} from "./client-test-support";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinMeta } from "@shared/types";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "@/hooks/__tests__/use-stablecoin-detail-view-model.test-support";

const {
  lazyViewportValues,
  nearViewportValues,
  longformScrollspyNavMock,
  useNearViewportMock,
  useStablecoinDetailViewModelMock,
  detailSectionNames,
  detailSectionIndex,
} = vi.hoisted(() => ({
  lazyViewportValues: [] as boolean[],
  nearViewportValues: [] as boolean[],
  longformScrollspyNavMock: vi.fn(),
  useNearViewportMock: vi.fn(),
  useStablecoinDetailViewModelMock: vi.fn(),
  detailSectionNames: [
    "McapChart",
    "MarketDataSection",
    "DEWSDetail",
    "StablecoinSafetyScoreV9Card",
    "ReservePanel",
    "DepegHistory",
    "FlowsSection",
    "FlowHistorySection",
    "BlacklistSection",
    "BlacklistHistorySection",
    "PegStabilityCard",
    "YieldDetailSection",
    "DexLiquidityCard",
    "DistributionSection",
    "SafetyScoreHistorySection",
    "StablecoinDepegResolverCard",
  ],
  detailSectionIndex: { current: 0 },
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    const source = loader.toString();
    const sectionName = source.includes("mod[name]") ? detailSectionNames[detailSectionIndex.current++] : source;
    if (sectionName.includes("ReservePanel")) {
      return function ReservePanelStub({
        reserves,
        onRetry,
        isFetching,
        isLoading,
      }: {
        reserves?: { mode?: string } | null;
        onRetry?: () => Promise<unknown> | void;
        isFetching?: boolean;
        isLoading?: boolean;
      }) {
        return (
          <section id="reserves" data-testid="reserve-panel">
            <span>{isLoading ? "loading-reserves" : reserves?.mode ?? "no-reserves"}</span>
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
    if (sectionName.includes("StablecoinSafetyScoreV9Card")) {
      return function ReportCardDetailStub({ rightColumn }: { rightColumn?: ReactNode }) {
        return <div data-testid="report-card">{rightColumn}</div>;
      };
    }
    if (sectionName.includes("FlowHistorySection")) {
      return function FlowHistorySectionStub() {
        return <div data-testid="flow-history-section" />;
      };
    }
    if (sectionName.includes("FlowsSection")) {
      return function FlowsSectionStub() {
        return <div data-testid="flows-section" />;
      };
    }
    if (sectionName.includes("BlacklistHistorySection")) {
      return function BlacklistHistorySectionStub() {
        return <div data-testid="blacklist-history-section" />;
      };
    }
    if (sectionName.includes("BlacklistSection")) {
      return function BlacklistSectionStub() {
        return <div data-testid="blacklist-section" />;
      };
    }
    return function DynamicPlaceholder() {
      return <div data-testid="dynamic-detail-section" />;
    };
  },
}));

vi.mock("next/link", async () => createNextLinkMock());

vi.mock("@/hooks/use-stablecoin-detail-view-model", () => createViewModelMock(useStablecoinDetailViewModelMock));

vi.mock("@/hooks/use-near-viewport", () => ({
  useNearViewport: useNearViewportMock,
}));

vi.mock("@/hooks/use-depeg-events", () => createDepegEventsMock());

vi.mock("@/lib/logos", () => createLogosMock());

vi.mock("@/components/stablecoin-logo", () => createStablecoinLogoMock());

vi.mock("@/components/stale-data-banner", () => createNoopComponentMock("StaleDataBanner"));

vi.mock("@/components/query-error-notice", () => createNoopComponentMock("QueryErrorNotice"));

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

vi.mock("@/components/stablecoin-detail/hero-card", () => createHeroCardMock());

vi.mock("@/components/stablecoin-detail/price-transparency-card", () => ({
  PriceTransparencyCard: () => <div data-testid="price-transparency-card" />,
}));

vi.mock("@/components/stablecoin-detail/redemption-backstop-card", () => ({
  RedemptionBackstopCard: ({ entry }: { entry: { stablecoinId: string } }) => (
    <section data-testid="redemption-backstop-card">{entry.stablecoinId}</section>
  ),
}));

vi.mock("@/components/ai-summary", () => ({
  AiSummary: () => <div data-testid="ai-summary" />,
}));

vi.mock("@/components/coin-notice", () => createNoopComponentMock("CoinNotices"));

vi.mock("@/components/tape-for-coin-teaser", () => createNoopComponentMock("TapeForCoinTeaser"));

vi.mock("@/components/feedback-modal", () => createNoopComponentMock("FeedbackModal"));

vi.mock("@/components/exploit-notice-banner", () => createNoopComponentMock("ExploitNoticeBanner"));

vi.mock("@/components/stablecoin-detail/recent-blacklist-banner", () => createNoopComponentMock("RecentBlacklistBanner"));

vi.mock("@/components/stablecoin-detail/contagion-snapshot", () => createContagionSnapshotMock());

describe("StablecoinDetailClient", () => {
  beforeEach(() => {
    lazyViewportValues.length = 0;
    nearViewportValues.length = 0;
    useNearViewportMock.mockReset();
    useNearViewportMock.mockImplementation((rootMargin?: string) => {
      const queue = rootMargin === "600px" ? nearViewportValues : lazyViewportValues;
      const near = useRef(queue.shift() ?? true).current;
      return {
        ref: { current: null },
        near,
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
    act(() => window.dispatchEvent(new Event("scroll")));

    expect(useStablecoinDetailViewModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supplementalQueryControls: {
          liquidity: true,
          reportCards: false,
          redemption: true,
          yield: true,
          stress: false,
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
    act(() => window.dispatchEvent(new Event("scroll")));

    expect(useStablecoinDetailViewModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supplementalQueryControls: {
          liquidity: true,
          reportCards: true,
          redemption: true,
          yield: false,
          stress: true,
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
        supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
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

  it("renders the xl summary rail as normal-flow content with in-flow copies owning the deep-link anchors", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const rail = container.querySelector('aside[aria-label="Coin summary rail"]');
    expect(rail).toBeTruthy();
    const railStack = rail?.firstElementChild;
    expect(railStack?.className).not.toContain("sticky");
    expect(railStack?.className).not.toContain("top-[");
    expect(railStack?.className).not.toContain("overflow-y-auto");
    expect(railStack?.className).not.toContain("max-h-");
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

  it("renders reserve composition inside a rated V9 Safety Score card", async () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const reportCard = makeV9Card({ id: coin.id });
    const reportCardsResponse = makeReportCardsV9Response({ cards: [reportCard] });
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        reportCard,
        reportCardsResponse,
        reportCardUpdatedAt: reportCardsResponse.updatedAt * 1000,
        reserves: {
          reserves: [{ name: "Curated reserve", pct: 100, risk: "low" }],
          estimated: false,
          mode: "curated-fallback",
        },
        featureStates: {
          ...makeReadyViewModel().featureStates,
          reserves: { status: "ready", dataUpdatedAt: 1, error: null },
        },
      }),
    );

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const reportCardElement = await screen.findByTestId("report-card");
    const reservePanel = await screen.findByTestId("reserve-panel");
    expect(reportCardElement.contains(reservePanel)).toBe(true);
    expect(reservePanel.textContent).toContain("curated-fallback");
  });

  it("holds the reserve column open while live composition is loading", async () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const reportCard = makeV9Card({ id: coin.id });
    const reportCardsResponse = makeReportCardsV9Response({ cards: [reportCard] });
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        reportCard,
        reportCardsResponse,
        featureStates: {
          ...makeReadyViewModel().featureStates,
          reserves: { status: "loading", dataUpdatedAt: 0, error: null },
        },
      }),
    );

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const reportCardElement = await screen.findByTestId("report-card");
    const reservePanel = await screen.findByTestId("reserve-panel");
    expect(reportCardElement.contains(reservePanel)).toBe(true);
    expect(reservePanel.textContent).toContain("loading-reserves");
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

  it("mounts the chart and distribution in the Market zone above DEX liquidity", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());

    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const banner = container.querySelector("#liquidity");
    const chart = container.querySelector("#chart");
    const distribution = container.querySelector("#distribution");
    const dexLiquidity = container.querySelector("#dex-liquidity");
    // The zone id stays `liquidity`; only its label reads "Market".
    expect(banner?.textContent).toContain("Market");
    expect(chart?.parentElement).toBe(dexLiquidity?.parentElement);
    expect(distribution?.parentElement).toBe(dexLiquidity?.parentElement);
    expect(chart!.compareDocumentPosition(distribution!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(distribution!.compareDocumentPosition(dexLiquidity!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(longformScrollspyNavMock.mock.calls[0]?.[0]?.sections).toEqual(
      expect.arrayContaining([{ id: "liquidity", label: "Market", icon: expect.anything() }]),
    );
  });

  it("orders the Context zone with the mechanism review folded after the zone-owned modules", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());

    const { container } = render(
      <StablecoinDetailClient
        id={coin.id}
        coin={coin}
        summary={null}
        staticCoin={buildStablecoinStaticMeta(coin)}
        mechanismReview={{
          archetype: "fiat-cash",
          reviewedAt: "2026-07-15",
          notes: "Reserves sit in segregated accounts.",
          sources: [{ label: "Terms", url: "https://example.com/terms" }],
        }}
        mechanismBacking={{
          archetype: "fiat-cash",
          reviewedAt: "2026-07-15",
          metrics: [],
          protocolFacts: [],
          notes: [],
          sourceLabel: "Terms",
          sourceUrl: "https://example.com/terms",
        }}
      />,
    );

    const mintAuthority = container.querySelector("#mint-authority");
    const mechanismReview = container.querySelector("#mechanism-review");
    // The anchor now lands on the collapsed fold band, not the card inside it.
    expect(mechanismReview?.tagName).toBe("DETAILS");
    expect((mechanismReview as HTMLDetailsElement).open).toBe(false);
    expect(mechanismReview?.closest("div")?.className).toContain("xl:hidden");
    expect(mintAuthority!.compareDocumentPosition(mechanismReview!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Reference material sits below the zone-owned modules and leads the folds.
    const contextZone = mechanismReview!.parentElement!.parentElement!;
    const foldBands = Array.from(contextZone.querySelectorAll('div[class~="xl:hidden"] > details'));
    expect(foldBands.length).toBeGreaterThan(1);
    expect(foldBands[0]).toBe(mechanismReview);
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

describe("StablecoinDetailClient (frozen)", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the FrozenStateBanner alongside the hero when status === frozen", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeFrozenViewModel(coin));
    render(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);
    expect(screen.getByRole("heading", { name: /Sunset by issuer\./ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /cemetery/i })).toBeTruthy();
  });

  it("renders FrozenDataNote labels above each chart section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeFrozenViewModel(coin));
    render(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);
    const notes = screen.getAllByText(/no longer collects new metrics/i);
    // Market chart, Distribution, Liquidity, History — non-flow / non-blacklist
    // sections render unconditionally for this fixture.
    expect(notes.length).toBeGreaterThanOrEqual(4);
  });

  it("renders the frozen banner before preserved AI prose", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue({
      ...makeFrozenViewModel(coin),
      summary: {
        title: "Archived note",
        text: "Pre-freeze prose.",
        updatedAt: "2026-04-01",
      },
    });
    render(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);

    const banner = screen.getByRole("heading", { name: /Sunset by issuer\./ });
    const summary = screen.getByTestId("ai-summary");
    expect(banner.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("buildStablecoinDetailMetadata (frozen)", () => {
  it("uses the archive-themed title and preserves the OG image", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const frozen: StablecoinMeta = { ...coin, status: "frozen", frozenAt: "2026-04-27", obituary };
    const meta = buildStablecoinDetailMetadata(frozen);
    expect(typeof meta.title === "string" ? meta.title : "").toContain("Failed Stablecoin Archive");
    const ogImages = meta.openGraph?.images;
    const firstImage = Array.isArray(ogImages) ? ogImages[0] : ogImages;
    const imageUrl = typeof firstImage === "object" && firstImage && "url" in firstImage ? firstImage.url : firstImage;
    expect(String(imageUrl)).toContain(`/api/og/stablecoin/${frozen.id}`);
  });
});
