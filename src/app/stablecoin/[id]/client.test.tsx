// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContagionSnapshotMock,
  createDepegEventsMock,
  createDetailLazySectionsMock,
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
} = vi.hoisted(() => ({
  lazyViewportValues: [] as boolean[],
  nearViewportValues: [] as boolean[],
  longformScrollspyNavMock: vi.fn(),
  useNearViewportMock: vi.fn(),
  useStablecoinDetailViewModelMock: vi.fn(),
}));

vi.mock("./detail-lazy-sections", () => createDetailLazySectionsMock());

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
  RedemptionRouteSection: ({ entry }: { entry: { stablecoinId: string } | null }) => (
    <section data-testid="redemption-route-section">{entry?.stablecoinId ?? "no-route"}</section>
  ),
}));

vi.mock("@/components/ai-summary", () => ({
  AiSummary: () => <div data-testid="ai-summary" />,
}));

vi.mock("@/components/coin-notice", () => createNoopComponentMock("CoinNotices"));

vi.mock("@/components/tape-for-coin-teaser", () => createNoopComponentMock("TapeForCoinTeaser"));

vi.mock("@/components/exploit-notice-banner", () => createNoopComponentMock("ExploitNoticeBanner"));

vi.mock("@/components/stablecoin-detail/contagion-snapshot", () => createContagionSnapshotMock());

// Viewport queues belong to every detail scenario, including isolated frozen cases.
beforeEach(() => {
  lazyViewportValues.length = 0;
  nearViewportValues.length = 0;
  useNearViewportMock.mockReset();
  useNearViewportMock.mockImplementation((rootMargin?: string) => {
    const queue = rootMargin === "600px" ? nearViewportValues : lazyViewportValues;
    const near = useRef(queue.shift() ?? true).current;
    return { ref: { current: null }, near };
  });
});

function renderDetail(coin = TRACKED_META_BY_ID.get("usds-sky")!) {
  return render(
    <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
  );
}

function makeAbsentPriceCoinData() {
  return { ...makeReadyViewModel().coinData, price: null };
}

describe("StablecoinDetailClient", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());
    longformScrollspyNavMock.mockClear();
  });

  it.each([
    { hasYieldSection: false, hasBlacklist: false, visible: false },
    { hasYieldSection: true, hasBlacklist: false, visible: true },
    { hasYieldSection: false, hasBlacklist: true, visible: true },
  ])("publishes the Activity destination only with content: $visible", ({ hasYieldSection, hasBlacklist, visible }) => {
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      hasFlows: true, hasYieldSection, hasBlacklist, blacklistSymbol: hasBlacklist ? "USDT" : null,
    }));
    const { container } = renderDetail();
    expect(container.querySelector("#activity") !== null).toBe(visible);
  });

  afterEach(() => {
    cleanup();
  });


  it.each([
    { name: "activity near", near: [false, true, false], redemption: false, flows: true, blacklist: true, reserves: false },
    { name: "overview near", near: [true, false, false], redemption: true, flows: true, blacklist: false, reserves: true },
    { name: "all lanes offscreen", near: [false, false, false], redemption: false, flows: false, blacklist: false, reserves: false },
  ])("keeps hero queries eager with $name", ({ near, redemption, flows, blacklist, reserves }) => {
    nearViewportValues.push(...near);
    renderDetail();
    expect(useStablecoinDetailViewModelMock).toHaveBeenCalledWith(expect.objectContaining({
      supplementalQueryControls: {
        ...DISABLED_DETAIL_QUERY_CONTROLS,
        liquidity: true, reportCards: true, yield: true, stress: true,
        redemption, flows, blacklist, reserves,
      },
    }));
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

    renderDetail(coin);

    expect(screen.queryByTestId("flows-section")).toBeNull();
    expect(screen.queryByTestId("blacklist-section")).toBeNull();
    expect(screen.getByTestId("flow-history-section")).toBeTruthy();
    expect(screen.getByTestId("blacklist-history-section")).toBeTruthy();
  });

  it("renders the parent variants card outside the overview section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = renderDetail(coin);

    const overviewSections = container.querySelectorAll("#overview");
    expect(overviewSections).toHaveLength(1);
    expect(screen.getByText("Variants")).toBeTruthy();
    expect(overviewSections[0]?.contains(screen.getByText("Variants"))).toBe(false);
    expect(screen.getAllByText("Sky Savings USDS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Staked USDS").length).toBeGreaterThan(0);
  });

  it("uses one full-width sticky banner scrollspy so desktop sections keep the full content width", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = renderDetail(coin);

    const scrollspyNavs = screen.getAllByTestId("scrollspy");
    expect(scrollspyNavs).toHaveLength(1);
    expect(scrollspyNavs[0]?.dataset.variant).toBe("banner");
    expect(scrollspyNavs[0]?.dataset.railLabel).toBe("Jump to");
    expect(scrollspyNavs[0]?.className).toContain("lg:w-full");
    expect(scrollspyNavs[0]?.className).toContain("lg:[&>div]:justify-center");
    expect(scrollspyNavs[0]?.className).toContain("lg:[&_nav]:flex-none");
    expect(scrollspyNavs[0]?.className).not.toContain("lg:w-fit");
    expect(container.querySelector('aside[aria-label="Section navigation"]')).toBeNull();
    expect(longformScrollspyNavMock).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "rail" }));
  });

  it("renders the xl summary rail as normal-flow content with in-flow copies owning the deep-link anchors", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = renderDetail(coin);

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

  it("mounts the reserves module in the score row when report-card data is unavailable", async () => {
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

    const { container } = renderDetail(coin);

    const reserves = await screen.findByTestId("reserves-section");
    expect(screen.queryByTestId("report-card")).toBeNull();
    expect(reserves.textContent).toContain("curated-fallback");
    expect(container.querySelector("#backing-evidence")?.contains(reserves)).toBe(false);
    const backingEvidence = container.querySelector("#backing-evidence")!;
    expect(reserves.compareDocumentPosition(backingEvidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry reserves" }).hasAttribute("disabled")).toBe(true);
  });

  it("orders the Risk zone as the Safety Score spine: score, then backing, exit and control evidence", async () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const reportCard = makeV9Card({ id: coin.id });
    const reportCardsResponse = makeReportCardsV9Response({ cards: [reportCard] });
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        reportCard,
        reportCardsResponse,
        reportCardUpdatedAt: reportCardsResponse.updatedAt * 1000,
        featureStates: {
          ...makeReadyViewModel().featureStates,
          reserves: { status: "loading", dataUpdatedAt: 0, error: null },
        },
      }),
    );

    const { container } = renderDetail(coin);

    const reportCardElement = await screen.findByTestId("report-card");
    const reserves = await screen.findByTestId("reserves-section");
    // The treemap left the score card: Reserves pairs with it in one row
    // (score first), ahead of the backing-evidence group.
    expect(reportCardElement.contains(reserves)).toBe(false);
    expect(reserves.textContent).toContain("loading-reserves");
    const scoreSection = container.querySelector("#report-card")!;
    expect(scoreSection.parentElement).toBe(reserves.parentElement?.parentElement);
    expect(scoreSection.compareDocumentPosition(reserves) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const spine = ["#reserves", "#backing-evidence", "#exit-evidence", "#control-evidence"].map(
      (selector) => container.querySelector(selector)!,
    );
    const overview = container.querySelector("#overview")!;
    for (const [index, node] of spine.entries()) {
      expect(overview.contains(node)).toBe(true);
      if (index > 0) {
        expect(spine[index - 1]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    }
    // Below-xl reference copies follow the evidence, in the Context zone.
    const contracts = container.querySelector("#contracts");
    if (contracts) {
      expect(spine[3]!.compareDocumentPosition(contracts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
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

    const { container } = renderDetail(coin);

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

    const { container } = renderDetail(coin);

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

    const { container } = renderDetail(coin);

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

  it("mounts each structural card once, in its pillar group, and indexes it from the rail", () => {
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

    const backingEvidence = container.querySelector("#backing-evidence");
    const controlEvidence = container.querySelector("#control-evidence");
    const mintAuthority = container.querySelector("#mint-authority");
    const mechanismReview = container.querySelector("#mechanism-review");
    const backingMechanics = container.querySelector("#backing-mechanics");
    // The anchor lands on the fold band itself — one mount at every width.
    expect(mechanismReview?.tagName).toBe("DETAILS");
    expect(mechanismReview?.closest('[class~="xl:hidden"]')).toBeNull();
    expect(controlEvidence?.contains(mintAuthority)).toBe(true);
    // Mechanism review explains the Backing pillar's mechanism scores.
    expect(backingEvidence?.contains(mechanismReview)).toBe(true);
    expect(backingEvidence?.contains(backingMechanics)).toBe(true);

    const rail = container.querySelector('aside[aria-label="Coin summary rail"]')!;
    const railLinks = Array.from(rail.querySelectorAll('[aria-label="Evidence index"] a')).map((link) =>
      link.getAttribute("href"),
    );
    expect(railLinks).toEqual(expect.arrayContaining(["#backing-mechanics", "#mechanism-review"]));
    // The rail holds index rows only, never a second copy of the card body.
    expect(rail.textContent).not.toContain("Reserves sit in segregated accounts.");
    expect(container.querySelectorAll("#mechanism-review")).toHaveLength(1);
  });

  it("mounts the redemption route in exit evidence, out of the Market zone", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        redemptionBackstop: {
          stablecoinId: coin.id,
        },
      }),
    );

    const { container } = renderDetail(coin);

    const redemptionRoute = screen.getByTestId("redemption-route-section");
    expect(container.querySelector("#exit-evidence")?.contains(redemptionRoute)).toBe(true);
    expect(container.querySelector("#dex-liquidity")?.parentElement?.contains(redemptionRoute)).toBe(false);
  });

  it("keeps the in-flow price panel in the Market zone below xl", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    renderDetail(coin);

    // Two instances render (Market zone + xl rail); the in-flow copy is the
    // one wrapped in the #price section.
    const priceCards = screen.getAllByTestId("price-transparency-card");
    expect(priceCards).toHaveLength(2);
    expect(priceCards.some((card) => card.closest("section#price") != null)).toBe(true);
  });

  it("omits the price panel when price transparency data is absent", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        coinData: makeAbsentPriceCoinData(),
        dexPriceCheck: null,
      }),
    );

    const { container } = renderDetail(coin);

    expect(screen.queryByTestId("price-transparency-card")).toBeNull();
    expect(container.querySelector("#price")).toBeNull();
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
    renderDetail(coin);
    expect(screen.getByRole("heading", { name: /Sunset by issuer\./ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /cemetery/i })).toBeTruthy();
  });

  it("renders FrozenDataNote labels above each chart section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeFrozenViewModel(coin));
    renderDetail(coin);
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
    renderDetail(coin);

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
