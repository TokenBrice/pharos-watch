// @vitest-environment jsdom

import { fireEvent, render as renderWithTestingLibrary, screen } from "@testing-library/react";
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
} from "./client-test-support";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { BRIDGE_TIER_LABELS } from "@shared/lib/classification";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
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

vi.mock("@/components/query-error-notice", () => createNoopComponentMock("QueryErrorNotice"));

vi.mock("@/components/longform-scrollspy-nav", () => ({
  LongformScrollspyNav: (props: { className?: string }) => {
    longformScrollspyNavMock(props);
    return (
      <nav
        data-testid="scrollspy"
        className={props.className}
      />
    );
  },
}));

vi.mock("@/components/stablecoin-detail/hero-card", () => createHeroCardMock());

vi.mock("@/components/stablecoin-detail/price-transparency-card", () => ({
  PriceTransparencyCard: () => <div data-testid="price-transparency-card" />,
}));

vi.mock("@/components/stablecoin-detail/redemption-backstop-card", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/stablecoin-detail/redemption-backstop-card")>();
  return {
    ...original,
    RedemptionRouteSection: (props: Parameters<typeof original.RedemptionRouteSection>[0]) => props.entry
      ? <section data-testid="redemption-route-section" data-freshness-updated-at={props.freshness?.dataUpdatedAt}>{props.entry.stablecoinId}</section>
      : <original.RedemptionRouteSection {...props} />,
  };
});

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

const queryClients: QueryClient[] = [];

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // These compositor tests supply a mocked view-model; transport launch is covered by request-budget tests.
  vi.spyOn(client, "prefetchQuery").mockResolvedValue(undefined);
  queryClients.push(client);
  return renderWithTestingLibrary(ui, {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

afterEach(() => {
  for (const client of queryClients) client.clear();
  queryClients.length = 0;
});

// Viewport queues belong to every detail scenario, including isolated frozen cases.
beforeEach(() => {
  lazyViewportValues.length = 0;
  nearViewportValues.length = 0;
  useNearViewportMock.mockReset();
  useNearViewportMock.mockImplementation((rootMargin?: string) => {
    const queue = rootMargin === "600px" ? nearViewportValues : lazyViewportValues;
    const near = useRef(queue.shift() ?? true).current;
    return { ref: () => {}, near };
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

  it("keeps the retained History preview through loading and list-error, then hands it to the ready dossier", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const preview = <div data-testid="depeg-history-preview">Latest 6 of 248 archived incidents</div>;
    const content = () => (
      <StablecoinDetailClient
        id={coin.id}
        coin={coin}
        summary={null}
        staticCoin={buildStablecoinStaticMeta(coin)}
        depegHistoryPreview={preview}
      />
    );

    useStablecoinDetailViewModelMock.mockReturnValue({ status: "loading", handleRetryAll: vi.fn() });
    const { container, rerender } = render(content());
    expect(screen.getAllByTestId("depeg-history-preview")).toHaveLength(1);
    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);
    // The preview is not waiting behind the removed outer History lazy gate.
    expect(container.querySelector("#depeg-history")?.closest("[data-lazy-section]")).toBeNull();

    useStablecoinDetailViewModelMock.mockReturnValue({
      status: "list-error",
      listError: new Error("offline"),
      handleRetryAll: vi.fn(),
    });
    rerender(content());
    expect(screen.getAllByTestId("depeg-history-preview")).toHaveLength(1);
    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);

    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());
    rerender(content());
    expect(screen.getAllByTestId("depeg-history-preview")).toHaveLength(1);
    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);
    expect(container.querySelector("#depeg-history")?.closest("[data-lazy-section]")).toBeNull();
  });

  it("keeps the History shell outside the viewport gate while unrelated sections stay lazy", () => {
    useNearViewportMock.mockImplementation(() => ({ ref: () => {}, near: false }));
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const preview = <div data-testid="depeg-history-preview">Latest 6 of 248 archived incidents</div>;
    const { container } = render(
      <StablecoinDetailClient
        id={coin.id}
        coin={coin}
        summary={null}
        staticCoin={buildStablecoinStaticMeta(coin)}
        depegHistoryPreview={preview}
      />,
    );

    expect(screen.getByTestId("depeg-history-preview")).toBeTruthy();
    expect(container.querySelector("#depeg-history")?.closest("[data-lazy-section]")).toBeNull();
    // The other distant modules still reserve and defer on their own gates.
    expect(container.querySelectorAll("[data-lazy-section]").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("dews-detail")).toBeNull();
  });

  it("shows a health notice only once detail evidence is past the stale band", () => {
    const now = Date.now();
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const query = {
      label: "Detail snapshot", staleTime: 15 * 60_000, hasData: true, dataUpdatedAt: now,
      error: null, meta: { updatedAt: now / 1000, ageSeconds: 0, status: "fresh" as const, warning: '199 - "Quality drift"' },
    };
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({ staleQueries: [query] }));
    const { container, rerender } = render(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);
    expect(container.querySelector("[data-health-state]")).toBeNull();
    for (const error of [null, new Error("offline")]) {
      useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
        staleQueries: [{ ...query, error, meta: { updatedAt: (now - 10 * 3600_000) / 1000, ageSeconds: 36000, status: "stale" as const } }],
      }));
      rerender(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);
      expect(container.querySelector("[data-health-state]")?.getAttribute("data-health-state")).toBe("stale");
      expect(container.textContent).toContain("Showing an older snapshot");
    }
  });

  it.each([
    { hasYieldSection: false, hasBlacklist: false, visible: false, label: null },
    { hasYieldSection: true, hasBlacklist: false, visible: true, label: "Yield" },
    { hasYieldSection: false, hasBlacklist: true, visible: true, label: "Blacklist" },
    { hasYieldSection: true, hasBlacklist: true, visible: true, label: "Yield & Blacklist" },
  ])("publishes the Activity destination only with content: $visible ($label)", ({ hasYieldSection, hasBlacklist, visible, label }) => {
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      hasFlows: true, hasYieldSection, hasBlacklist, blacklistSymbol: hasBlacklist ? "USDT" : null,
    }));
    const { container } = renderDetail();
    expect(container.querySelector("#activity") !== null).toBe(visible);
    // The pill and the banner name only the modules the zone holds.
    const sections: Array<{ id: string; label: string }> = longformScrollspyNavMock.mock.calls.at(-1)?.[0]?.sections ?? [];
    expect(sections.find((section) => section.id === "activity")?.label ?? null).toBe(label);
    if (label) expect(container.querySelector("#activity")?.textContent).toContain(label);
  });

  it("labels the stable #liquidity zone in searchers' words", () => {
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({ hasFlows: true }));
    const { container } = renderDetail();
    const sections: Array<{ id: string; label: string }> = longformScrollspyNavMock.mock.calls.at(-1)?.[0]?.sections ?? [];
    expect(sections.find((section) => section.id === "liquidity")?.label).toBe("Supply & Liquidity");
    expect(container.querySelector("#liquidity")?.textContent).toContain("Supply & Liquidity");
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

  it("prerenders Explore next without a viewport gate, in the ready and loading dossier alike", () => {
    useNearViewportMock.mockImplementation(() => ({ ref: () => {}, near: false }));
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const content = () => (
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)}
        heading="Sky Dollar (USDS)"
        exploreNextContent={<section id="explore-next"><h2 id="explore-next-heading">Explore cards</h2></section>} />
    );
    const { container, rerender } = render(content());
    expect(screen.getByText("Explore cards")).toBeTruthy();
    expect(container.querySelectorAll("#explore-next")).toHaveLength(1);
    useStablecoinDetailViewModelMock.mockReturnValue({ status: "loading", handleRetryAll: vi.fn() });
    rerender(content());
    expect(screen.getByText("Explore cards")).toBeTruthy();
    // The loading dossier's visible title is the page's only h1.
    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(`${coin.name} (${coin.symbol})`);
  });

  it("keeps the canonical mechanism destination in a loading dossier", () => {
    const exploreNextContent = <section id="explore-next"><h2 id="explore-next-heading">Explore cards</h2></section>;
    const renderLoading = (coinId: string) => {
      const coin = TRACKED_META_BY_ID.get(coinId)!;
      useStablecoinDetailViewModelMock.mockReturnValue({ status: "loading", handleRetryAll: vi.fn() });
      return render(
        <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)}
          exploreNextContent={exploreNextContent} />,
      );
    };

    const cases = [
      // History-gap profiles keep their canonical fiat-backed explainer.
      ...["brz-transfero", "jpyc-jpyc", "kgst-kyrgyz-som", "idrx-idrx", "cngn-compliant-naira", "brl1-brl1", "wcop-ripio"]
        .map((id) => ({ id, label: "Learn how fiat-backed stablecoins work", href: "/learn/mechanisms/fiat-cash/" })),
      // Inherited variant: susn-noon has no own archetype, so the parent's applies.
      { id: "susn-noon", label: "Learn how credit-fund stablecoins work", href: "/learn/mechanisms/rwa-credit-fund/" },
      // Explicit override: the wrapper keeps its own archetype over the parent's.
      { id: "skymoneyusdtsavings-sky", label: "Learn how protocol-position stablecoins work", href: "/learn/mechanisms/protocol-position/" },
    ];
    for (const { id, label, href } of cases) {
      const { container, unmount } = renderLoading(id);
      const link = screen.getByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
      // The destination sits immediately before the retained Explore node.
      expect(link.parentElement?.nextElementSibling).toBe(container.querySelector("#explore-next"));
      expect(screen.getByText("Explore cards")).toBeTruthy();
      unmount();
    }

    // An unresolved custom design emits no fabricated destination.
    const { container } = renderLoading("usdr-ring");
    expect(screen.queryByRole("link", { name: /Learn how .* stablecoins work/ })).toBeNull();
    expect(container.querySelector('a[href^="/learn/mechanisms/"]')).toBeNull();
    expect(screen.getByText("Explore cards")).toBeTruthy();
  });

  it("drops the loading mechanism CTA when the ready dossier replaces the shell", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const content = () => (
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)}
        exploreNextContent={<section id="explore-next"><h2 id="explore-next-heading">Explore cards</h2></section>} />
    );
    useStablecoinDetailViewModelMock.mockReturnValue({ status: "loading", handleRetryAll: vi.fn() });
    const { rerender } = render(content());
    expect(screen.getAllByRole("link", { name: "Learn how CDP stablecoins work" })).toHaveLength(1);

    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());
    rerender(content());
    // One ready explainer remains; the loading-only link is gone.
    const explainers = screen.getAllByRole("link", { name: "Learn how CDP stablecoins work" });
    expect(explainers).toHaveLength(1);
    expect(explainers[0]!.getAttribute("href")).toBe("/learn/mechanisms/cdp/");
    expect(screen.getAllByText("Explore cards")).toHaveLength(1);
  });

  it("reserves distant reference islands and keeps one Explore alias set before and after mounting", () => {
    let near = false;
    useNearViewportMock.mockImplementation((rootMargin?: string) => ({
      ref: () => {},
      near: rootMargin === "600px" || near,
    }));
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const content = () => (
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)}
        exploreNextContent={<section id="explore-next"><h2 id="explore-next-heading">Explore cards</h2></section>} />
    );
    const { container, rerender } = render(content());
    for (const id of ["liquidity", "chart", "distribution", "dex-liquidity", "history", "coin-timeline", "explore", "explore-next", "explore-next-heading"]) {
      expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    // The hidden mobile reference cards do not repeat the rail's eager observers.
    expect(screen.getAllByTestId("price-transparency-card")).toHaveLength(1);
    near = true;
    rerender(content());
    expect(screen.getByText("Explore cards")).toBeTruthy();
    expect(container.querySelectorAll("#explore-next")).toHaveLength(1);
    expect(container.querySelectorAll("#explore-next-heading")).toHaveLength(1);
  });

  it("keeps flows and blacklist children behind their own lazy gates", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    // SG-2 added independent DEWS/chart/distribution gates before these panels.
    // Drive visibility from the mounted reserve, not the incidental hook order.
    useNearViewportMock.mockImplementation((rootMargin?: string) => {
      const [near, setNear] = useState(rootMargin === "600px");
      const ref = useCallback((node: HTMLDivElement | null) => {
        if (!node) return;
        const isOverviewFlows = node.style.minHeight === "440px";
        const isActivityBlacklist = node.style.minHeight === "480px" && !node.closest("#dex-liquidity");
        setNear(!isOverviewFlows && !isActivityBlacklist);
      }, []);
      return { ref, near };
    });
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        hasFlows: true,
        hasFlowHistory: true,
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




  it("keeps the collateralization and access rail footprints through pending and populated evidence", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const pending = { redemption: { status: "empty", dataUpdatedAt: 0, error: null }, reserves: { status: "loading", dataUpdatedAt: 0, error: null } };
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({ reportCard: null, reserves: null, featureStates: pending }));
    const { container, rerender } = renderDetail(coin);
    const collateralization = container.querySelector('[data-rail-slot="collateralization"]')!;
    expect(collateralization.textContent).toContain("Waiting for reserve evidence.");
    expect(collateralization.className).toBe("min-h-64");
    // No published access posture and no pending grade read: the access card stays hidden.
    expect(container.querySelector('[data-rail-slot="access"]')).toBeNull();
    expect(container.textContent).not.toContain("Published access posture is unavailable.");
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({ reportCard: makeV9Card({ id: coin.id }), reserves: LIVE_COLLATERALIZED_RESERVES }),
    );
    rerender(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);
    expect(container.querySelector('[data-rail-slot="collateralization"]')).toBe(collateralization);
    expect(collateralization.className).toBe("min-h-64");
    expect(container.querySelector('[data-rail-slot="access"]')!.className).toBe("min-h-48");
  });

  it.each(["empty", "unavailable"])("hides the collateralization rail card once a %s reserve read settles without a KPI", (status) => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const settled = { redemption: { status: "empty", dataUpdatedAt: 0, error: null }, reserves: { status, dataUpdatedAt: 0, error: null } };
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({ reportCard: null, reserves: null, featureStates: settled }));
    const { container } = renderDetail(coin);
    expect(container.querySelector('[data-rail-slot="collateralization"]')).toBeNull();
    expect(container.textContent).not.toContain("Collateralization evidence is unavailable.");
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



  it("uses the market data section for non-yield-bearing USD assets with supply history", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(
      makeReadyViewModel({
        supplyHistory: [{ date: "2026-01-01", mcap: 100, price: 1, supply: 100 }],
      }),
    );

    const { container } = renderDetail(coin);

    // The permanent anchor survives while the chart module is viewport-gated.
    expect(container.querySelector("#chart")).toBeTruthy();
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
    ["deferred", "Waiting for section"],
    ["loading", "Loading"],
    ["unavailable", "Unavailable"],
    ["empty", "Not reviewed"],
  ] as const)("uses the same redemption %s state in the main strip and index", (status, label) => {
    const base = makeReadyViewModel();
    const handleRetryAll = vi.fn();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      handleRetryAll,
      featureStates: { ...base.featureStates, redemption: { status, dataUpdatedAt: 0, error: status === "unavailable" ? new Error("offline") : null } },
    }));
    const { container } = renderDetail();
    const main = container.querySelector("#redemption")!;
    const index = container.querySelector('[aria-label="Evidence index"] a[href="#redemption"]')!;
    expect(main.textContent).toContain(label);
    expect(index.textContent).toContain(label);
    expect(main.getAttribute("data-evidence-state") === "not-reviewed").toBe(status === "empty");
    if (status === "unavailable") {
      fireEvent.click(screen.getByRole("button", { name: "Retry redemption" }));
      expect(handleRetryAll).toHaveBeenCalledOnce();
    } else {
      expect(screen.queryByRole("button", { name: "Retry redemption" })).toBeNull();
    }
  });

  it("preserves a retained redemption route instead of replacing it with unavailable", () => {
    const base = makeReadyViewModel();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      redemptionBackstop: { stablecoinId: base.coin.id, score: 79, routeFamily: "offchain-issuer" },
      featureStates: { ...base.featureStates, redemption: { status: "retained", dataUpdatedAt: 1, error: new Error("offline") } },
    }));
    const { container } = renderDetail();
    expect(screen.getByTestId("redemption-route-section").textContent).toBe(base.coin.id);
    expect(container.querySelector('[aria-label="Evidence index"] a[href="#redemption"]')?.textContent).toContain("79");
    expect(screen.queryByRole("button", { name: "Retry redemption" })).toBeNull();
  });

  it("hands the redemption footer the page's own redemption health lane", () => {
    const base = makeReadyViewModel();
    const lane = { preset: "redemptionBackstops" as const, dataUpdatedAt: 1_700_000_000_000, error: null, hasData: true, meta: null };
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      redemptionBackstop: { stablecoinId: base.coin.id, score: 79, routeFamily: "offchain-issuer" },
      staleQueries: [{ preset: "reportCards", dataUpdatedAt: 1, error: null, hasData: true, meta: null }, lane],
    }));
    renderDetail();
    expect(screen.getByTestId("redemption-route-section").getAttribute("data-freshness-updated-at")).toBe(String(lane.dataUpdatedAt));
  });

  it("keeps reviewed no-holder evidence authoritative before the live read settles", () => {
    const coin = TRACKED_META_BY_ID.get("frax-frax")!;
    const base = makeReadyViewModel();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      id: coin.id, coin,
      featureStates: { ...base.featureStates, redemption: { status: "deferred", dataUpdatedAt: 0, error: null } },
    }));
    const { container } = renderDetail(coin);
    expect(container.querySelector("#redemption")?.textContent).toContain("No holder");
    expect(container.querySelector('[aria-label="Evidence index"] a[href="#redemption"]')?.textContent).toContain("No holder route");
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


describe("StablecoinDetailClient (frozen S14)", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
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
    // Market chart, Distribution, History — current DEX liquidity is omitted for an archive.
    expect(notes.length).toBeGreaterThanOrEqual(3);
  });

  it("omits current DEX liquidity and dependency context while keeping static relationships and flow history", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue({ ...makeFrozenViewModel(coin), hasFlows: false, hasFlowHistory: true });
    const { container } = renderDetail(coin);
    expect(container.querySelector("#dex-liquidity")).toBeNull();
    expect(container.querySelector("#distribution")).not.toBeNull();
    expect(screen.queryByTestId("contagion-snapshot-mock")).toBeNull();
    expect(screen.getByTestId("flow-history-section")).toBeTruthy();
    expect(screen.queryByTestId("flows-section")).toBeNull();
  });

  it("starts no current summary read for a frozen archive, unlike an active control", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const frozen = makeFrozenViewModel(coin);
    useStablecoinDetailViewModelMock.mockReturnValue(frozen);
    renderDetail(frozen.coin);
    expect(queryClients.at(-1)!.prefetchQuery).not.toHaveBeenCalled();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());
    renderDetail(coin);
    expect(queryClients.at(-1)!.prefetchQuery).toHaveBeenCalledTimes(1);
  });

});

