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
import { resolveBoardGridPlacement } from "./detail-risk-context-sections";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { BRIDGE_TIER_LABELS } from "@shared/lib/classification";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinMeta } from "@shared/types";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "@/hooks/__tests__/use-stablecoin-detail-view-model.test-support";
import failureScenarios from "@data/failure-scenarios.json";
import type { FailureScenariosById } from "@shared/types/failure-scenarios";

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

vi.mock("./detail-lazy-sections", async () => createDetailLazySectionsMock());

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

vi.mock("@/components/stablecoin-detail/redemption-backstop-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/stablecoin-detail/redemption-backstop-card")>()),
  RedemptionRouteSection: ({ entry }: { entry: { stablecoinId: string } | null }) => (
    <section data-testid="redemption-route-section">{entry?.stablecoinId ?? "no-route"}</section>
  ),
  hasRedemptionRouteModule: (entry: unknown) => entry != null,
}));

// Freeze & seizure reads blacklist usage near the viewport; no query client here.
vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: () => ({ data: undefined, dataUpdatedAt: 0 }),
  useBlacklistEventsPage: () => ({ data: { events: [], total: 0 }, isLoading: false, isError: false }),
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

/** A live collateralization ratio mounts the Backing KPI twin, so the Backing board renders. */
const LIVE_COLLATERALIZED_RESERVES = {
  reserves: [{ name: "Vault collateral", pct: 100, risk: "low" }],
  estimated: false,
  mode: "live",
  liveAt: 1_780_000_000,
  metadata: { collateralizationRatio: 1.24 },
};

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

  it.each([
    { label: "with a scenario", withScenario: true },
    { label: "without one", withScenario: false },
  ])("publishes the How it breaks pill and section only $label", ({ withScenario }) => {
    const coin = TRACKED_META_BY_ID.get("crvusd-curve")!;
    const scenario = (failureScenarios as FailureScenariosById)["crvusd-curve"]!;
    const { container } = render(
      <StablecoinDetailClient
        id={coin.id}
        coin={coin}
        summary={null}
        staticCoin={buildStablecoinStaticMeta(coin)}
        failureScenario={withScenario ? { scenario, isDraft: true } : null}
      />,
    );
    const sectionIds = longformScrollspyNavMock.mock.calls[0]?.[0]?.sections.map((section: { id: string }) => section.id);
    expect(sectionIds.includes("how-it-breaks")).toBe(withScenario);
    expect(container.querySelector("#how-it-breaks") !== null).toBe(withScenario);
    if (!withScenario) return;
    // Risk → How it breaks → Context, and the draft preview says so.
    expect(sectionIds.slice(0, 2)).toEqual(["overview", "how-it-breaks"]);
    const overview = container.querySelector("#overview")!;
    const banner = container.querySelector("#how-it-breaks")!;
    expect(overview.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText("Draft — not approved").length).toBeGreaterThan(0);
    const branchStages = scenario.branchPoint?.branches.flatMap((branch) => branch.stages) ?? [];
    expect(container.querySelectorAll("#failure-scenario details[data-scenario-step]")).toHaveLength(
      scenario.stages.length + branchStages.length,
    );
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

  it("renders one banner scrollspy rather than a separate section-navigation rail", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = renderDetail(coin);

    const scrollspyNavs = screen.getAllByTestId("scrollspy");
    expect(scrollspyNavs).toHaveLength(1);
    expect(scrollspyNavs[0]?.dataset.variant).toBe("banner");
    expect(scrollspyNavs[0]?.dataset.railLabel).toBe("Jump to");
    expect(container.querySelector('aside[aria-label="Section navigation"]')).toBeNull();
    expect(longformScrollspyNavMock).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "rail" }));
  });

  it("keeps the summary rail separate from the unique in-flow deep-link anchors", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = renderDetail(coin);

    const rail = container.querySelector('aside[aria-label="Coin summary rail"]');
    expect(rail).toBeTruthy();
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
    // Control evidence always renders (Mint Authority or its "Not reviewed" state).
    const controlEvidence = container.querySelector("#control-evidence")!;
    expect(controlEvidence.contains(reserves)).toBe(false);
    expect(reserves.compareDocumentPosition(controlEvidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
        // Every pillar board needs a module to render.
        reserves: LIVE_COLLATERALIZED_RESERVES,
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

  it("mounts every evidence module once in its board, with rail twins and a complete evidence index", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      reserves: LIVE_COLLATERALIZED_RESERVES,
    }));

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
      />,
    );

    const backingEvidence = container.querySelector("#backing-evidence")!;
    const controlEvidence = container.querySelector("#control-evidence")!;
    // Mechanism review is the Mechanism card's provenance fold, mounted once, outside the boards.
    expect(container.querySelectorAll("#mechanism-review")).toHaveLength(1);
    expect(container.querySelector("#info")?.contains(container.querySelector("#mechanism-review"))).toBe(true);
    expect(backingEvidence.contains(container.querySelector("#mechanism-review"))).toBe(false);
    // No mint review: the explicit S14 state owns the anchor in its slot.
    const mint = container.querySelector("#mint-authority");
    expect(controlEvidence.contains(mint)).toBe(true);
    expect(mint?.getAttribute("data-evidence-state")).toBe("not-reviewed");

    // Rail metric cards are twins: the in-flow copy owns the id, inside its board.
    const rail = container.querySelector('aside[aria-label="Coin summary rail"]')!;
    for (const [anchor, board] of [["collateralization", backingEvidence], ["jurisdiction", controlEvidence]] as const) {
      const owners = container.querySelectorAll(`#${anchor}`);
      expect(owners).toHaveLength(1);
      expect(board.contains(owners[0]!)).toBe(true);
      expect(rail.contains(owners[0]!)).toBe(false);
      expect(rail.querySelector(`[data-anchor-twin="${anchor}"]`)).not.toBeNull();
    }

    // Every index row lands on exactly one in-flow mount outside the rail.
    const railLinks = Array.from(rail.querySelectorAll('[aria-label="Evidence index"] a')).map((link) =>
      link.getAttribute("href")!,
    );
    // The index lists modules only: the mechanism review lives in the Mechanism card.
    expect(railLinks).toEqual(expect.arrayContaining(["#mint-authority", "#bridging"]));
    expect(railLinks).not.toContain("#mechanism-review");
    for (const href of railLinks) {
      const targets = container.querySelectorAll(href);
      expect(targets).toHaveLength(1);
      expect(rail.contains(targets[0]!)).toBe(false);
    }
    // The rail never repeats a module body.
    expect(rail.textContent).not.toContain("Reserves sit in segregated accounts.");
  });

  it("places the live stress layer under Score and Reserves, ahead of the pillar boards", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const reportCard = makeV9Card({ id: coin.id });
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      reportCard,
      reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }),
      // The Backing board needs a module to render.
      reserves: LIVE_COLLATERALIZED_RESERVES,
    }));

    const { container } = renderDetail(coin);

    const dews = screen.getByTestId("dews-detail");
    const score = container.querySelector("#report-card")!;
    const backingEvidence = container.querySelector("#backing-evidence")!;
    expect(score.compareDocumentPosition(dews) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dews.compareDocumentPosition(backingEvidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("states that DEWS does not apply to NAV tokens instead of omitting it silently", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({ isNavToken: true }));

    const { container } = renderDetail(coin);

    expect(screen.queryByTestId("dews-detail")).toBeNull();
    const notApplicable = container.querySelector('#overview [data-evidence-state="not-applicable"]');
    expect(notApplicable).not.toBeNull();
    const controlEvidence = container.querySelector("#control-evidence")!;
    expect(notApplicable!.compareDocumentPosition(controlEvidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("never leaves a board kicker whose only content is hidden at xl", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const reportCard = makeV9Card({ id: coin.id });
    // Boards carry plain kickers, so the frozen Exit board's only possible
    // child is the below-xl Access posture twin.
    useStablecoinDetailViewModelMock.mockReturnValue({ ...makeFrozenViewModel(coin), reportCard });

    const { container } = renderDetail(coin);

    const exitEvidence = container.querySelector("#exit-evidence");
    expect(exitEvidence === null || exitEvidence.classList.contains("xl:hidden")).toBe(true);
    expect(container.querySelector("#control-evidence")?.classList.contains("xl:hidden")).toBe(false);
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

  it("states a missing redemption route in the Exit board and indexes it", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({ redemptionBackstop: undefined }));

    const { container } = renderDetail(coin);

    const redemption = container.querySelector("#redemption");
    expect(container.querySelector("#exit-evidence")?.contains(redemption)).toBe(true);
    expect(redemption?.getAttribute("data-evidence-state")).toBe("not-reviewed");
    const rail = container.querySelector('aside[aria-label="Coin summary rail"]')!;
    const row = rail.querySelector('[aria-label="Evidence index"] a[href="#redemption"]');
    expect(row?.textContent).toContain("Redemption route");
    expect(row?.textContent).toContain("Not reviewed");
  });

  it.each([
    { name: "no route qualifies", primaryRoute: null, note: "not counted" },
    { name: "Exit scores this route", primaryRoute: "usds-sky", note: null },
    { name: "Exit scores another coin's route of the same family", primaryRoute: "usdc-circle", note: "not selected" },
    { name: "Exit selects a colliding route suffix", primaryRoute: "other:usds-sky", note: "not selected" },
    { name: "Exit selects a composed route suffix", primaryRoute: "composed:usds-sky", note: "not selected" },
  ])("qualifies the indexed redemption score when $name", ({ primaryRoute, note }) => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const routeFamily = "offchain-issuer";
    const reportCard = structuredClone(makeV9Card({ id: coin.id }));
    const exit = reportCard.breakdowns!.exit;
    if (primaryRoute === null) exit.primaryRoute = null;
    else {
      exit.primaryRoute!.key = `redemption:generation:redemption:${primaryRoute}:${routeFamily}`;
      exit.primaryRoute!.routeId = `redemption:${primaryRoute}:${routeFamily}`;
      exit.primaryRoute!.lane = "redemption";
    }
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      reportCard,
      reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }),
      redemptionBackstop: { stablecoinId: coin.id, score: 79, routeFamily },
    }));

    const { container } = renderDetail(coin);

    const row = container.querySelector('[aria-label="Evidence index"] a[href="#redemption"]')!;
    expect(row.textContent).toContain("79");
    if (note) expect(row.textContent).toContain(note);
    else expect(row.textContent).not.toMatch(/not counted|not selected/);
  });

  it.each([
    { routeId: "redemption:usds-sky:offchain-issuer", lane: "redemption", expected: "backup" },
    { routeId: "redemption:other:usds-sky:offchain-issuer", lane: "redemption", expected: "not selected" },
    { routeId: "redemption:usds-sky:offchain-issuer", lane: "dex", expected: "not selected" },
  ] as const)("joins the indexed backup by typed identity ($routeId, $lane)", ({ routeId, lane, expected }) => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const reportCard = structuredClone(makeV9Card({ id: coin.id }));
    const exit = reportCard.breakdowns!.exit;
    const key = "redemption:generation:redemption:usds-sky:offchain-issuer";
    exit.diversification = { routeKey: key, routeLabel: "Backup", bonus: 2 };
    exit.alternatives = [{
      key, routeId, lane, label: "Backup", routeFamily: "issuer-redemption", score: 70,
      included: true, exclusionReason: null, confidenceDimensions: null,
      capacityEvidenceTier: "documented", rawSameNotionalCostBps: null,
    }];
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      reportCard, reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }),
      redemptionBackstop: { stablecoinId: coin.id, score: 79, routeFamily: "offchain-issuer" },
    }));
    const { container } = renderDetail(coin);
    const row = container.querySelector('[aria-label="Evidence index"] a[href="#redemption"]')!;
    expect(row.textContent).toContain(expected);
  });

  it.each([
    { name: "Exit selects another route", primaryRoute: "usdc-circle", expected: "NR · not selected" },
    { name: "no route qualifies", primaryRoute: null, expected: "NR · not counted" },
  ])("indexes an unrated redemption route as NR, never a blank row, when $name", ({ primaryRoute, expected }) => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const routeFamily = "offchain-issuer";
    const reportCard = structuredClone(makeV9Card({ id: coin.id }));
    const exit = reportCard.breakdowns!.exit;
    if (primaryRoute === null) exit.primaryRoute = null;
    else {
      exit.primaryRoute!.key = `redemption:generation:redemption:${primaryRoute}:${routeFamily}`;
      exit.primaryRoute!.routeId = `redemption:${primaryRoute}:${routeFamily}`;
      exit.primaryRoute!.lane = "redemption";
    }
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      reportCard,
      reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }),
      redemptionBackstop: { stablecoinId: coin.id, score: null, routeFamily },
    }));

    const { container } = renderDetail(coin);

    const row = container.querySelector('[aria-label="Evidence index"] a[href="#redemption"]')!;
    expect(row.textContent).toContain(expected);
  });

  it("reads bridging on a single-chain coin as not applicable, not as a missing review", () => {
    const coin = { ...TRACKED_META_BY_ID.get("usds-sky")!, contracts: [] };
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({ coin }));

    const { container } = renderDetail(coin);

    const bridging = container.querySelector("#bridging");
    expect(bridging?.getAttribute("data-evidence-state")).toBe("not-applicable");
    expect(bridging?.textContent).toContain(BRIDGE_TIER_LABELS["single-chain-or-native"]);
  });
});

describe("resolveBoardGridPlacement", () => {
  /** Auto-placement without `dense`: the unfilled tracks of every row that a span wraps past, plus the last row. */
  function holes(spans: readonly number[], tracks: number): number[] {
    const gaps: number[] = [];
    let column = 0;
    for (const span of spans) {
      if (column + span > tracks) {
        gaps.push(tracks - column);
        column = 0;
      }
      column = (column + span) % tracks;
    }
    if (column > 0) gaps.push(tracks - column);
    return gaps;
  }

  const cases = Array.from({ length: 8 }, (_, tiles) => [0, 1].map((twins) => ({ tiles, twins }))).flat();

  it.each(cases)("never leaves an empty track with $tiles tiles and $twins twins", ({ tiles, twins }) => {
    const placements = resolveBoardGridPlacement(tiles, twins);
    const tilePlacements = placements.slice(0, tiles);

    // Below xl: tiles and twins share two tracks.
    expect(holes(placements.map((placement) => (placement.rowAtTwo === "always" ? 2 : 1)), 2)).toEqual([]);
    // At xl, two tracks: twins are hidden.
    expect(holes(tilePlacements.map((placement) => (placement.rowAtTwo === "never" ? 1 : 2)), 2)).toEqual([]);
    // At xl, three tracks drawn as six half-tracks; twins never reach them.
    expect(placements.slice(tiles).every((placement) => placement.halfTracksAtThree === null)).toBe(true);
    expect(holes(tilePlacements.map((placement) => placement.halfTracksAtThree ?? 0), 6)).toEqual([]);
    // Strip form only for a tile that spans the row at two tracks.
    for (const placement of tilePlacements) {
      expect(placement.stripForm).toBe(placement.rowAtTwo !== "never");
    }
  });

  it("splits two tiles across the three-track row instead of leaving a third empty", () => {
    expect(resolveBoardGridPlacement(2, 0).map((placement) => placement.halfTracksAtThree)).toEqual([3, 3]);
  });

  it("pairs a lone tile with a twin below xl and spans it only at xl", () => {
    const [tile, twin] = resolveBoardGridPlacement(1, 1);
    expect(tile).toMatchObject({ rowAtTwo: "xl", stripForm: true });
    expect(twin).toMatchObject({ rowAtTwo: "never", halfTracksAtThree: null });
  });
});

describe("StablecoinDetailClient (frozen S14)", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the reduced dossier: DEWS reads frozen archive and no placeholder claims a missing review", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const reportCard = makeV9Card({ id: coin.id });
    useStablecoinDetailViewModelMock.mockReturnValue({ ...makeFrozenViewModel(coin), reportCard });

    const { container } = renderDetail(coin);

    expect(screen.queryByTestId("dews-detail")).toBeNull();
    const notApplicable = container.querySelector('#overview [data-evidence-state="not-applicable"]');
    expect(notApplicable?.textContent).toContain("frozen archive");
    // Mint Authority's own state is the only "Not reviewed" left.
    const notReviewed = Array.from(container.querySelectorAll('[data-evidence-state="not-reviewed"]'));
    expect(notReviewed.map((node) => node.id)).toEqual(["mint-authority"]);
  });

  it("links no Exit evidence from the Safety Score when the Exit board has no module", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    // Frozen, with no redemption route and no known access posture: nothing mounts in the Exit board.
    const { accessPosture } = makeV9Card({ id: coin.id });
    const reportCard = makeV9Card({
      id: coin.id,
      accessPosture: {
        ...accessPosture,
        transfer: "unknown",
        freezeExposure: "unknown",
        primaryExit: "unknown",
        governance: "unknown",
        unknownFields: ["transfer", "freezeExposure", "primaryExit", "governance"],
      },
    });
    useStablecoinDetailViewModelMock.mockReturnValue({
      ...makeFrozenViewModel(coin),
      reportCard,
      reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }),
    });

    const { container } = renderDetail(coin);

    expect(container.querySelector("#exit-evidence")).toBeNull();
    expect(screen.queryByRole("link", { name: "Exit evidence" })).toBeNull();
    expect(screen.getByRole("link", { name: "Economic Control evidence" }).getAttribute("href")).toBe("#control-evidence");
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
