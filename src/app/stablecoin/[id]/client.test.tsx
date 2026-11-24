// @vitest-environment jsdom

import { fireEvent, render as renderWithTestingLibrary, screen } from "@testing-library/react";
import { useCallback, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContagionSnapshotMock, createDepegEventsMock, createDetailLazySectionsMock,
  createHeroCardMock, createLogosMock, createNextLinkMock, createNoopComponentMock,
  createStablecoinLogoMock, createViewModelMock, makeFrozenViewModel, makeReadyViewModel,
} from "./client-test-support";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { BRIDGE_TIER_LABELS } from "@shared/lib/classification";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "@/hooks/__tests__/use-stablecoin-detail-view-model.test-support";
import failureScenarios from "@data/failure-scenarios.json";
import aiSummaries from "@data/ai-summaries.json";
import type { StablecoinAiSummary } from "@shared/types/editorial";
import type { FailureScenariosById } from "@shared/types/failure-scenarios";

const { lazyViewportValues, nearViewportValues, longformScrollspyNavMock, useNearViewportMock, useViewModelMock } = vi.hoisted(() => ({
  lazyViewportValues: [] as boolean[],
  nearViewportValues: [] as boolean[],
  longformScrollspyNavMock: vi.fn(),
  useNearViewportMock: vi.fn(),
  useViewModelMock: vi.fn(),
}));

vi.mock("./detail-lazy-sections", async () => createDetailLazySectionsMock());
vi.mock("next/link", async () => createNextLinkMock());
vi.mock("@/hooks/use-stablecoin-detail-view-model", () => createViewModelMock(useViewModelMock));
vi.mock("@/hooks/use-near-viewport", () => ({ useNearViewport: useNearViewportMock }));
vi.mock("@/hooks/use-depeg-events", () => createDepegEventsMock());
vi.mock("@/lib/logos", () => createLogosMock());
vi.mock("@/components/stablecoin-logo", () => createStablecoinLogoMock());
vi.mock("@/components/query-error-notice", () => createNoopComponentMock("QueryErrorNotice"));
vi.mock("@/components/longform-scrollspy-nav", () => ({
  LongformScrollspyNav: (props: { className?: string }) => {
    longformScrollspyNavMock(props);
    return <nav data-testid="scrollspy" className={props.className} />;
  },
}));
vi.mock("@/components/stablecoin-detail/hero-card", () => createHeroCardMock());
vi.mock("@/components/stablecoin-detail/price-transparency-card", () => ({ PriceTransparencyCard: () => <div data-testid="price-transparency-card" /> }));
vi.mock("@/components/stablecoin-detail/redemption-backstop-card", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/stablecoin-detail/redemption-backstop-card")>();
  return {
    ...original,
    RedemptionRouteSection: (props: Parameters<typeof original.RedemptionRouteSection>[0]) => props.entry
      ? <section data-testid="redemption-route-section" data-freshness-updated-at={props.freshness?.dataUpdatedAt}>{props.entry.stablecoinId}</section>
      : <original.RedemptionRouteSection {...props} />,
  };
});
vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: () => ({ data: undefined, dataUpdatedAt: 0 }),
  useBlacklistEventsPage: () => ({ data: { events: [], total: 0 }, isLoading: false, isError: false }),
}));
vi.mock("@/components/ai-summary/ai-summary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ai-summary/ai-summary")>();
  const { hasAvailableAiSummaryClaims } = await import("@shared/lib/ai-summary-claims");
  return {
    AiSummary: (props: ComponentProps<typeof actual.AiSummary>) =>
      hasAvailableAiSummaryClaims(props.text, props.claimTokens, props.claimValues)
        ? <div data-testid="ai-summary"><actual.AiSummary {...props} /></div>
        : null,
  };
});
vi.mock("@/components/coin-notice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/coin-notice")>()),
  NoticeStack: ({ notices }: { notices: readonly { title: string }[] }) => notices.length > 0 ? <div data-testid="notice-stack">{notices.map((n) => n.title).join(" | ")}</div> : null,
}));
vi.mock("@/components/tape/tape-for-coin-teaser", () => createNoopComponentMock("TapeForCoinTeaser"));
vi.mock("@/components/stablecoin-detail/contagion-snapshot", () => createContagionSnapshotMock());

const queryClients: QueryClient[] = [];
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, "prefetchQuery").mockResolvedValue(undefined);
  queryClients.push(client);
  return renderWithTestingLibrary(ui, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

afterEach(() => {
  for (const client of queryClients) client.clear();
  queryClients.length = 0;
});

beforeEach(() => {
  lazyViewportValues.length = 0;
  nearViewportValues.length = 0;
  useNearViewportMock.mockReset().mockImplementation((rootMargin?: string) => {
    const queue = rootMargin === "600px" ? nearViewportValues : lazyViewportValues;
    const near = useRef(queue.shift() ?? true).current;
    return { ref: () => {}, near };
  });
});

const coinOf = (id: string) => TRACKED_META_BY_ID.get(id)!;
const USDS = coinOf("usds-sky");
const EXPLORE_NEXT = <section id="explore-next"><h2 id="explore-next-heading">Explore cards</h2></section>;
const PREVIEW = <div data-testid="depeg-history-preview">Latest 6 of 248 archived incidents</div>;
type DetailExtraProps = Partial<Omit<ComponentProps<typeof StablecoinDetailClient>, "id" | "coin" | "staticCoin">>;

const detailEl = (coin = USDS, extra: DetailExtraProps = {}) => (
  <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} {...extra} />
);
const renderDetail = (coin = USDS, extra: DetailExtraProps = {}) => render(detailEl(coin, extra));
const mockReady = (overrides: Parameters<typeof makeReadyViewModel>[0] = {}) => useViewModelMock.mockReturnValue(makeReadyViewModel(overrides));
const mockLoading = () => useViewModelMock.mockReturnValue({ status: "loading", handleRetryAll: vi.fn() });
const followsNode = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const indexLink = (container: HTMLElement, href: string) => container.querySelector(`[aria-label="Evidence index"] a[href="${href}"]`);

const LIVE_COLLATERALIZED_RESERVES = {
  reserves: [{ name: "Vault collateral", pct: 100, risk: "low" }],
  estimated: false, mode: "live", liveAt: 1_780_000_000, metadata: { collateralizationRatio: 1.24 },
};

function mockRedemptionRoute(primaryRoute: string | null, score: number | null) {
  const routeFamily = "offchain-issuer";
  const reportCard = structuredClone(makeV9Card({ id: USDS.id }));
  const exit = reportCard.breakdowns!.exit;
  if (primaryRoute === null) exit.primaryRoute = null;
  else {
    exit.primaryRoute!.key = `redemption:generation:redemption:${primaryRoute}:${routeFamily}`;
    exit.primaryRoute!.routeId = `redemption:${primaryRoute}:${routeFamily}`;
    exit.primaryRoute!.lane = "redemption";
  }
  mockReady({
    reportCard,
    reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }),
    redemptionBackstop: { stablecoinId: USDS.id, score, routeFamily },
  });
}

describe("StablecoinDetailClient", () => {
  beforeEach(() => {
    useViewModelMock.mockReset();
    mockReady();
    longformScrollspyNavMock.mockClear();
  });

  it("keeps the retained History preview through loading and list-error, then hands it to the ready dossier", () => {
    const content = () => detailEl(USDS, { depegHistoryPreview: PREVIEW });
    mockLoading();
    const { container, rerender } = render(content());
    expect(screen.getAllByTestId("depeg-history-preview")).toHaveLength(1);
    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);
    expect(container.querySelector("#depeg-history")?.closest("[data-lazy-section]")).toBeNull();

    useViewModelMock.mockReturnValue({ status: "list-error", listError: new Error("offline"), handleRetryAll: vi.fn() });
    rerender(content());
    expect(screen.getAllByTestId("depeg-history-preview")).toHaveLength(1);
    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);

    mockReady();
    rerender(content());
    expect(screen.getAllByTestId("depeg-history-preview")).toHaveLength(1);
    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);
    expect(container.querySelector("#depeg-history")?.closest("[data-lazy-section]")).toBeNull();
  });

  it("keeps the History shell outside the viewport gate with preview, and lazy without preview", () => {
    useNearViewportMock.mockImplementation(() => ({ ref: () => {}, near: false }));
    const { container, unmount } = renderDetail(USDS, { depegHistoryPreview: PREVIEW });
    expect(screen.getByTestId("depeg-history-preview")).toBeTruthy();
    expect(container.querySelector("#depeg-history")?.closest("[data-lazy-section]")).toBeNull();
    expect(container.querySelectorAll("[data-lazy-section]").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("dews-detail")).toBeNull();
    unmount();

    const { container: bare } = renderDetail(USDS);
    expect(bare.querySelector("#depeg-history")).toBeNull();
    expect(screen.queryByTestId("history-tabs")).toBeNull();
    expect([...bare.querySelectorAll<HTMLElement>("[data-lazy-section]")].some((n) => n.style.minHeight === "390px")).toBe(true);
  });

  it("shows a health notice only once detail evidence is past the stale band", () => {
    const now = Date.now();
    const query = {
      label: "Detail snapshot", staleTime: 15 * 60_000, hasData: true, dataUpdatedAt: now,
      error: null, meta: { updatedAt: now / 1000, ageSeconds: 0, status: "fresh" as const, warning: '199 - "Quality drift"' },
    };
    mockReady({ staleQueries: [query] });
    const { container, rerender } = renderDetail();
    expect(container.querySelector("[data-health-state]")).toBeNull();
    for (const error of [null, new Error("offline")]) {
      mockReady({ staleQueries: [{ ...query, error, meta: { updatedAt: (now - 10 * 3600_000) / 1000, ageSeconds: 36000, status: "stale" as const } }] });
      rerender(detailEl());
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
    mockReady({ hasFlows: true, hasYieldSection, hasBlacklist, blacklistSymbol: hasBlacklist ? "USDT" : null });
    const { container } = renderDetail();
    expect(container.querySelector("#activity") !== null).toBe(visible);
    const sections: Array<{ id: string; label: string }> = longformScrollspyNavMock.mock.calls.at(-1)?.[0]?.sections ?? [];
    expect(sections.find((s) => s.id === "activity")?.label ?? null).toBe(label);
    if (label) expect(container.querySelector("#activity")?.textContent).toContain(label);
  });

  it("labels #liquidity in searchers' words and opens Risk on #overview with Safety Score ahead of Mechanism", () => {
    mockReady({ hasFlows: true });
    const { container } = renderDetail();
    const sections: Array<{ id: string; label: string }> = longformScrollspyNavMock.mock.calls.at(-1)?.[0]?.sections ?? [];
    expect(sections.find((s) => s.id === "liquidity")?.label).toBe("Supply & Liquidity");
    expect(container.querySelector("#liquidity")?.textContent).toContain("Supply & Liquidity");

    const overview = container.querySelector("#overview")!;
    expect(overview.tagName).toBe("SECTION");
    expect(overview.querySelector("#overview-heading")?.textContent).toBe("Risk");
    expect(overview.contains(container.querySelector("#report-card"))).toBe(true);
    expect(followsNode(container.querySelector("#report-card")!, container.querySelector("#info")!)).toBe(true);
  });

  it.each([
    { label: "with a scenario", withScenario: true },
    { label: "without one", withScenario: false },
  ])("publishes the How it breaks pill and section only $label", ({ withScenario }) => {
    const coin = coinOf("crvusd-curve");
    const scenario = (failureScenarios as FailureScenariosById)["crvusd-curve"]!;
    const { container } = renderDetail(coin, { failureScenario: withScenario ? { scenario, isDraft: true } : null });
    const sectionIds = longformScrollspyNavMock.mock.calls[0]?.[0]?.sections.map((s: { id: string }) => s.id);
    expect(sectionIds.includes("how-it-breaks")).toBe(withScenario);
    expect(container.querySelector("#how-it-breaks") !== null).toBe(withScenario);
    if (!withScenario) return;
    expect(sectionIds.slice(0, 2)).toEqual(["overview", "how-it-breaks"]);
    expect(followsNode(container.querySelector("#overview")!, container.querySelector("#how-it-breaks")!)).toBe(true);
    expect(screen.getAllByText("Draft · not approved").length).toBeGreaterThan(0);
    const branchStages = scenario.branchPoint?.branches.flatMap((b) => b.stages) ?? [];
    expect(container.querySelectorAll("#failure-scenario details[data-scenario-step]")).toHaveLength(scenario.stages.length + branchStages.length);
  });

  it.each([
    { name: "activity near", near: [false, true, false], flows: true, blacklist: true },
    { name: "overview near", near: [true, false, false], flows: true, blacklist: false },
    { name: "all lanes offscreen", near: [false, false, false], flows: false, blacklist: false },
  ])("keeps hero and first-fold rail queries eager with $name", ({ near, flows, blacklist }) => {
    nearViewportValues.push(...near);
    renderDetail();
    expect(useViewModelMock).toHaveBeenCalledWith(expect.objectContaining({
      supplementalQueryControls: {
        ...DISABLED_DETAIL_QUERY_CONTROLS,
        liquidity: true, reportCards: true, redemption: true, yield: true, stress: true, reserves: true, flows, blacklist,
      },
    }));
  });

  it("prerenders Explore next without a viewport gate, in ready and loading dossier, and drops loading CTA when ready", () => {
    useNearViewportMock.mockImplementation(() => ({ ref: () => {}, near: false }));
    const content = () => detailEl(USDS, { heading: "Sky Dollar (USDS)", exploreNextContent: EXPLORE_NEXT });
    mockLoading();
    const { container, rerender } = render(content());
    expect(screen.getByText("Explore cards")).toBeTruthy();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe(`${USDS.name} (${USDS.symbol})`);
    expect(screen.getAllByRole("link", { name: "Learn how CDP stablecoins work" })).toHaveLength(1);

    mockReady();
    rerender(content());
    expect(screen.getAllByText("Explore cards")).toHaveLength(1);
    expect(container.querySelectorAll("#explore-next")).toHaveLength(1);
    const explainers = screen.getAllByRole("link", { name: "Learn how CDP stablecoins work" });
    expect(explainers).toHaveLength(1);
    expect(explainers[0]!.getAttribute("href")).toBe("/learn/mechanisms/cdp/");
  });

  it("keeps the canonical mechanism destination in a loading dossier", () => {
    const cases = [
      ...["brz-transfero", "jpyc-jpyc", "kgst-kyrgyz-som", "idrx-idrx", "cngn-compliant-naira", "brl1-brl1", "wcop-ripio"]
        .map((id) => ({ id, label: "Learn how fiat-backed stablecoins work", href: "/learn/mechanisms/fiat-cash/" })),
      { id: "susn-noon", label: "Learn how credit-fund stablecoins work", href: "/learn/mechanisms/rwa-credit-fund/" },
      { id: "skymoneyusdtsavings-sky", label: "Learn how protocol-position stablecoins work", href: "/learn/mechanisms/protocol-position/" },
    ];
    for (const { id, label, href } of cases) {
      mockLoading();
      const { container, unmount } = renderDetail(coinOf(id), { exploreNextContent: EXPLORE_NEXT });
      const link = screen.getByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.parentElement?.nextElementSibling).toBe(container.querySelector("#explore-next"));
      expect(screen.getByText("Explore cards")).toBeTruthy();
      unmount();
    }
    mockLoading();
    const { container } = renderDetail(coinOf("usdr-ring"), { exploreNextContent: EXPLORE_NEXT });
    expect(screen.queryByRole("link", { name: /Learn how .* stablecoins work/ })).toBeNull();
    expect(container.querySelector('a[href^="/learn/mechanisms/"]')).toBeNull();
    expect(screen.getByText("Explore cards")).toBeTruthy();
  });

  it("keeps the #contracts destination in the loading dossier from registry deployments", () => {
    mockLoading();
    const { container, rerender, unmount } = renderDetail(USDS);
    expect(container.querySelectorAll("#contracts")).toHaveLength(1);
    expect(container.textContent).toContain("Contract addresses");

    mockReady();
    rerender(detailEl(USDS));
    expect(container.querySelectorAll("#contracts")).toHaveLength(1);
    unmount();

    mockLoading();
    expect(renderDetail(coinOf("hbd-hive")).container.querySelector("#contracts")).toBeNull();
  });

  it("reserves distant reference islands and keeps one Explore alias set before and after mounting", () => {
    let near = false;
    useNearViewportMock.mockImplementation((rootMargin?: string) => ({ ref: () => {}, near: rootMargin === "600px" || near }));
    const content = () => detailEl(USDS, { exploreNextContent: EXPLORE_NEXT });
    const { container, rerender } = render(content());
    for (const id of ["liquidity", "chart", "distribution", "dex-liquidity", "history", "coin-timeline", "explore", "explore-next", "explore-next-heading"]) {
      expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    expect(screen.getAllByTestId("price-transparency-card")).toHaveLength(1);
    near = true;
    rerender(content());
    expect(screen.getByText("Explore cards")).toBeTruthy();
    expect(container.querySelectorAll("#explore-next")).toHaveLength(1);
    expect(container.querySelectorAll("#explore-next-heading")).toHaveLength(1);
  });

  it("keeps flows and blacklist children behind their own lazy gates", () => {
    useNearViewportMock.mockImplementation((rootMargin?: string) => {
      const [near, setNear] = useState(rootMargin === "600px");
      const ref = useCallback((node: HTMLDivElement | null) => {
        if (!node) return;
        const follows = (id: string) => {
          const divider = document.getElementById(id);
          return divider !== null && followsNode(divider, node);
        };
        setNear(node.style.minHeight !== "440px" && !(node.style.minHeight === "" && follows("activity") && !follows("history")));
      }, []);
      return { ref, near };
    });
    mockReady({ hasFlows: true, hasFlowHistory: true, hasBlacklist: true, blacklistSymbol: "USDT", supplyHistory: [{ date: "2026-01-01", mcap: 100, price: 1, supply: 100 }] });
    renderDetail();
    expect(screen.queryByTestId("flows-section")).toBeNull();
    expect(screen.queryByTestId("blacklist-section")).toBeNull();
    expect(screen.getByTestId("flow-history-section")).toBeTruthy();
    expect(screen.getByTestId("blacklist-history-section")).toBeTruthy();
  });

  it("keeps the collateralization and access rail footprints through pending and populated evidence", () => {
    const pending = { redemption: { status: "empty", dataUpdatedAt: 0, error: null }, reserves: { status: "loading", dataUpdatedAt: 0, error: null } };
    mockReady({ reportCard: null, reserves: null, featureStates: pending });
    const { container, rerender } = renderDetail();
    const collateralization = container.querySelector('[data-rail-slot="collateralization"]')!;
    expect(collateralization.textContent).toContain("Waiting for reserve evidence.");
    expect(collateralization.className).toBe("min-h-64");
    expect(container.querySelector('[data-rail-slot="access"]')).toBeNull();
    expect(container.textContent).not.toContain("Published access posture is unavailable.");

    mockReady({ reportCard: makeV9Card({ id: USDS.id }), reserves: LIVE_COLLATERALIZED_RESERVES });
    rerender(detailEl());
    expect(container.querySelector('[data-rail-slot="collateralization"]')).toBe(collateralization);
    expect(collateralization.className).toBe("");
    expect(container.querySelector('[data-rail-slot="access"]')!.className).toBe("");
  });

  it.each(["empty", "unavailable"])("hides the collateralization rail card once a %s reserve read settles without a KPI", (status) => {
    mockReady({ reportCard: null, reserves: null, featureStates: { redemption: { status: "empty", dataUpdatedAt: 0, error: null }, reserves: { status, dataUpdatedAt: 0, error: null } } });
    const { container } = renderDetail();
    expect(container.querySelector('[data-rail-slot="collateralization"]')).toBeNull();
    expect(container.textContent).not.toContain("Collateralization evidence is unavailable.");
  });

  it("mounts the reserves module in the score row when report-card data is unavailable", async () => {
    mockReady({
      reportCard: null,
      reserves: { reserves: [{ name: "Curated reserve", pct: 100, risk: "low" }], estimated: false, mode: "curated-fallback" },
      refetchReserves: vi.fn().mockResolvedValue({ status: "success" }),
      isFetchingReserves: true,
    });
    const { container } = renderDetail();
    const reserves = await screen.findByTestId("reserves-section");
    expect(screen.queryByTestId("report-card")).toBeNull();
    expect(reserves.textContent).toContain("curated-fallback");
    const controlEvidence = container.querySelector("#control-evidence")!;
    expect(controlEvidence.contains(reserves)).toBe(false);
    expect(followsNode(reserves, controlEvidence)).toBe(true);
    expect(screen.getByRole("button", { name: "Retry reserves" }).hasAttribute("disabled")).toBe(true);
  });

  it("reserves the paired score column only while a saved grade awaits its card, never for coins without one", () => {
    const coin = { ...TRACKED_META_BY_ID.get("usdt-tether")!, reserves: [{ name: "T-Bills", pct: 100, risk: "very-low" as const }], reserveQualitySummary: undefined, reserveLookThrough: undefined };
    const staticCoin = buildStablecoinStaticMeta(coin);
    const grid = (el: HTMLElement) => el.querySelector("#report-card")!.parentElement!;
    const slot = (el: HTMLElement) => el.querySelector("#report-card [data-score-card-placeholder]");
    const card = makeV9Card({ id: coin.id });
    const renderState = (vm: Record<string, unknown>, rerender?: (ui: Parameters<typeof render>[0]) => void) => {
      useViewModelMock.mockReturnValue(vm);
      const ui = <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={staticCoin} />;
      return rerender ? (rerender(ui), null) : render(ui);
    };

    const savedHero = { savedGrade: { grade: "C", score: 54, asOfMs: 1_780_000_000_000 }, signalRailItems: [] };
    const { container, rerender } = renderState(makeReadyViewModel({ coin, gradeRead: "pending", hero: savedHero }))!;
    expect(grid(container).className).toContain("lg:grid-cols-2");
    expect(slot(container)).not.toBeNull();

    renderState(makeReadyViewModel({ coin, reportCard: card, reportCardsResponse: makeReportCardsV9Response({ cards: [card] }) }), rerender);
    expect(grid(container).className).toContain("lg:grid-cols-2");
    expect(slot(container)).toBeNull();
    expect(screen.getByTestId("report-card")).toBeTruthy();

    // Without a saved grade the read may settle with no card, so nothing is reserved to collapse.
    for (const vm of [makeReadyViewModel({ coin, gradeRead: "pending" }), makeReadyViewModel({ coin, gradeRead: "failed" }), { ...makeFrozenViewModel(coin), gradeRead: "pending" }]) {
      renderState(vm, rerender);
      expect(grid(container).className).not.toContain("lg:grid-cols-2");
      expect(slot(container)).toBeNull();
    }
  });

  it.each([false, true])("mounts #chart for USD assets with supply history (yieldBearing=%s)", (yieldBearing) => {
    const coin = yieldBearing ? { ...USDS, flags: { ...USDS.flags, yieldBearing: true, navToken: false, pegCurrency: "USD" as const } } : USDS;
    mockReady({ coin, isNavToken: false, supplyHistory: [{ date: "2026-01-01", mcap: 100, price: yieldBearing ? 1.01 : 1, supply: yieldBearing ? 99 : 100 }] });
    const { container } = renderDetail(coin);
    expect(container.querySelector("#chart")).toBeTruthy();
    if (!yieldBearing) expect(screen.getAllByTestId("dynamic-detail-section").length).toBeGreaterThan(0);
  });

  it("mounts every evidence module once in its board, with rail twins and a complete evidence index", () => {
    mockReady({ reserves: LIVE_COLLATERALIZED_RESERVES });
    const { container } = renderDetail(USDS, {
      mechanismReview: { archetype: "fiat-cash", reviewedAt: "2026-07-15", notes: "Reserves sit in segregated accounts.", sources: [{ label: "Terms", url: "https://example.com/terms" }] },
    });
    const backingEvidence = container.querySelector("#backing-evidence")!;
    const controlEvidence = container.querySelector("#control-evidence")!;
    expect(container.querySelectorAll("#mechanism-review")).toHaveLength(1);
    expect(container.querySelector("#info")?.contains(container.querySelector("#mechanism-review"))).toBe(true);
    expect(backingEvidence.contains(container.querySelector("#mechanism-review"))).toBe(false);

    const mint = container.querySelector("#mint-authority");
    expect(controlEvidence.contains(mint)).toBe(true);
    expect(mint?.getAttribute("data-evidence-state")).toBe("not-reviewed");

    const rail = container.querySelector('aside[aria-label="Coin summary rail"]')!;
    for (const [anchor, board] of [["collateralization", backingEvidence], ["jurisdiction", controlEvidence]] as const) {
      const owners = container.querySelectorAll(`#${anchor}`);
      expect(owners).toHaveLength(1);
      expect(board.contains(owners[0]!)).toBe(true);
      expect(rail.contains(owners[0]!)).toBe(false);
      expect(rail.querySelector(`[data-anchor-twin="${anchor}"]`)).not.toBeNull();
    }

    const railLinks = Array.from(rail.querySelectorAll('[aria-label="Evidence index"] a')).map((l) => l.getAttribute("href")!);
    expect(railLinks).toEqual(expect.arrayContaining(["#mint-authority", "#bridging"]));
    expect(railLinks).not.toContain("#mechanism-review");
    for (const href of railLinks) {
      const targets = container.querySelectorAll(href);
      expect(targets).toHaveLength(1);
      expect(rail.contains(targets[0]!)).toBe(false);
    }
    expect(rail.textContent).not.toContain("Reserves sit in segregated accounts.");
  });

  it("omits DEWS for NAV tokens, price panel when absent, and bridging for single-chain coins", () => {
    mockReady({ isNavToken: true, coinData: { ...makeReadyViewModel().coinData, price: null }, dexPriceCheck: null, coin: { ...USDS, contracts: [] } });
    const { container } = renderDetail({ ...USDS, contracts: [] });
    expect(screen.queryByTestId("dews-detail")).toBeNull();
    expect(container.querySelector('[data-evidence-state="not-applicable"]')).toBeNull();
    expect(screen.queryByTestId("price-transparency-card")).toBeNull();
    expect(container.querySelector("#price")).toBeNull();
    expect(container.querySelector("#bridging")).toBeNull();
    expect(indexLink(container, "#bridging")).toBeNull();
    expect(container.textContent).not.toContain(BRIDGE_TIER_LABELS["single-chain-or-native"]);
  });

  it("states a missing redemption route in the Exit board and indexes it", () => {
    mockReady({ redemptionBackstop: undefined });
    const { container } = renderDetail();
    const redemption = container.querySelector("#redemption");
    expect(container.querySelector("#exit-evidence")?.contains(redemption)).toBe(true);
    expect(redemption?.getAttribute("data-evidence-state")).toBe("not-reviewed");
    const row = indexLink(container, "#redemption");
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
    mockReady({ handleRetryAll, featureStates: { ...base.featureStates, redemption: { status, dataUpdatedAt: 0, error: status === "unavailable" ? new Error("offline") : null } } });
    const { container } = renderDetail();
    const main = container.querySelector("#redemption")!;
    expect(main.textContent).toContain(label);
    expect(indexLink(container, "#redemption")!.textContent).toContain(label);
    expect(main.getAttribute("data-evidence-state") === "not-reviewed").toBe(status === "empty");
    if (status === "unavailable") {
      fireEvent.click(screen.getByRole("button", { name: "Retry redemption" }));
      expect(handleRetryAll).toHaveBeenCalledOnce();
    } else expect(screen.queryByRole("button", { name: "Retry redemption" })).toBeNull();
  });

  it("preserves a retained redemption route and hands the footer its own health lane", () => {
    const base = makeReadyViewModel();
    const lane = { preset: "redemptionBackstops" as const, dataUpdatedAt: 1_700_000_000_000, error: null, hasData: true, meta: null };
    mockReady({
      redemptionBackstop: { stablecoinId: base.coin.id, score: 79, routeFamily: "offchain-issuer" },
      featureStates: { ...base.featureStates, redemption: { status: "retained", dataUpdatedAt: 1, error: new Error("offline") } },
      staleQueries: [{ preset: "reportCards", dataUpdatedAt: 1, error: null, hasData: true, meta: null }, lane],
    });
    const { container } = renderDetail();
    const section = screen.getByTestId("redemption-route-section");
    expect(section.textContent).toBe(base.coin.id);
    expect(section.getAttribute("data-freshness-updated-at")).toBe(String(lane.dataUpdatedAt));
    expect(indexLink(container, "#redemption")?.textContent).toContain("79");
    expect(screen.queryByRole("button", { name: "Retry redemption" })).toBeNull();
  });

  it("keeps reviewed no-holder evidence authoritative before the live read settles", () => {
    const coin = coinOf("frax-frax");
    const base = makeReadyViewModel();
    mockReady({ id: coin.id, coin, featureStates: { ...base.featureStates, redemption: { status: "deferred", dataUpdatedAt: 0, error: null } } });
    const { container } = renderDetail(coin);
    expect(container.querySelector("#redemption")?.textContent).toContain("No holder");
    expect(indexLink(container, "#redemption")?.textContent).toContain("No holder route");
  });

  it.each([
    { name: "no route qualifies", primaryRoute: null, score: 79, note: "not counted" },
    { name: "Exit scores this route", primaryRoute: "usds-sky", score: 79, note: null },
    { name: "Exit scores another coin's route of the same family", primaryRoute: "usdc-circle", score: 79, note: "not selected" },
    { name: "Exit selects a colliding route suffix", primaryRoute: "other:usds-sky", score: 79, note: "not selected" },
    { name: "Exit selects a composed route suffix", primaryRoute: "composed:usds-sky", score: 79, note: "not selected" },
    { name: "unrated & Exit selects another route", primaryRoute: "usdc-circle", score: null, note: "NR · not selected" },
    { name: "unrated & no route qualifies", primaryRoute: null, score: null, note: "NR · not counted" },
  ])("qualifies the indexed redemption score when $name", ({ primaryRoute, score, note }) => {
    mockRedemptionRoute(primaryRoute, score);
    const row = indexLink(renderDetail().container, "#redemption")!;
    if (score !== null) expect(row.textContent).toContain(String(score));
    if (note) expect(row.textContent).toContain(note);
    else expect(row.textContent).not.toMatch(/not counted|not selected/);
  });

  it.each([
    { routeId: "redemption:usds-sky:offchain-issuer", lane: "redemption", expected: "backup" },
    { routeId: "redemption:other:usds-sky:offchain-issuer", lane: "redemption", expected: "not selected" },
    { routeId: "redemption:usds-sky:offchain-issuer", lane: "dex", expected: "not selected" },
  ] as const)("joins the indexed backup by typed identity ($routeId, $lane)", ({ routeId, lane, expected }) => {
    const reportCard = structuredClone(makeV9Card({ id: USDS.id }));
    const exit = reportCard.breakdowns!.exit;
    const key = "redemption:generation:redemption:usds-sky:offchain-issuer";
    exit.diversification = { routeKey: key, routeLabel: "Backup", bonus: 2 };
    exit.alternatives = [{ key, routeId, lane, label: "Backup", routeFamily: "issuer-redemption", score: 70, included: true, exclusionReason: null, confidenceDimensions: null, capacityEvidenceTier: "documented", rawSameNotionalCostBps: null }];
    mockReady({ reportCard, reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }), redemptionBackstop: { stablecoinId: USDS.id, score: 79, routeFamily: "offchain-issuer" } });
    expect(indexLink(renderDetail().container, "#redemption")!.textContent).toContain(expected);
  });
});

describe("StablecoinDetailClient (frozen S14)", () => {
  beforeEach(() => { useViewModelMock.mockReset(); });

  it("keeps the reduced dossier: no DEWS, and no placeholder claims a missing review", () => {
    useViewModelMock.mockReturnValue({ ...makeFrozenViewModel(USDS), reportCard: makeV9Card({ id: USDS.id }) });
    const { container } = renderDetail();
    expect(screen.queryByTestId("dews-detail")).toBeNull();
    expect(container.querySelector('[data-evidence-state="not-applicable"]')).toBeNull();
    expect(Array.from(container.querySelectorAll('[data-evidence-state="not-reviewed"]')).map((n) => n.id)).toEqual(["mint-authority"]);
  });

  it("links no Exit evidence from the Safety Score when the Exit board has no module", () => {
    const { accessPosture } = makeV9Card({ id: USDS.id });
    const reportCard = makeV9Card({
      id: USDS.id,
      accessPosture: { ...accessPosture, transfer: "unknown", freezeExposure: "unknown", primaryExit: "unknown", governance: "unknown", unknownFields: ["transfer", "freezeExposure", "primaryExit", "governance"] },
    });
    useViewModelMock.mockReturnValue({ ...makeFrozenViewModel(USDS), reportCard, reportCardsResponse: makeReportCardsV9Response({ cards: [reportCard] }) });
    const { container } = renderDetail();
    expect(container.querySelector("#exit-evidence")).toBeNull();
    expect(screen.queryByRole("link", { name: "Exit evidence" })).toBeNull();
    expect(screen.getByRole("link", { name: "Economic Control evidence" }).getAttribute("href")).toBe("#control-evidence");
  });
});

describe("StablecoinDetailClient lead slot", () => {
  it("orders lead-slot notices around the hero and routes secondary refresh failures to the header ops chip", () => {
    mockReady({
      coin: { ...USDS, notices: [
        { type: "warning", title: "Deadline", message: "M.", kind: "deadline", deadline: "2026-11-26" },
        { type: "warning", title: "Paused", message: "M.", kind: "paused" },
        { type: "danger", title: "Danger", message: "M." },
      ] },
      staleQueries: [{ preset: "yieldRankings", dataUpdatedAt: 0, error: new Error("HTTP 502"), hasData: false, meta: null, secondary: true }],
    });
    renderDetail();
    const stacks = screen.getAllByTestId("notice-stack");
    expect(stacks.map((s) => s.textContent)).toEqual(["Danger", "Paused", "Deadline"]);
    const order = [stacks[1]!, screen.getByTestId("hero-card"), stacks[2]!];
    expect(order.slice(1).every((next, i) => followsNode(order[i]!, next))).toBe(true);
    const chip = screen.getByTestId("hero-identity-toolbar").querySelector("[data-secondary-ops-chip][data-health-state='error']");
    expect(chip?.textContent).toContain("Partial refresh");
  });

  it("routes stale restored supply into the header ops chip rather than a top-of-hero banner", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useViewModelMock.mockReturnValue(makeReadyViewModel({
      coin,
      staleQueries: [{ label: "Supply", secondary: true, staleTime: 600_000, dataUpdatedAt: 1_700_000_000_000, error: null, hasData: true, meta: { updatedAt: 1_700_000_000, ageSeconds: 10_000, status: "stale" } }],
    }));
    const { container } = renderDetail(coin);
    const chip = screen.getByTestId("hero-identity-toolbar").querySelector("[data-secondary-ops-chip][data-health-state='stale']");
    expect(chip?.textContent).toContain("Older snapshot");
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  it("hoists sticky section tabs above AiSummary and prioritizes Contracts and Key links at the top of the rail", () => {
    const coin = coinOf("usdc-circle");
    mockReady({
      coin,
      hero: { signalRailItems: [{ key: "grade", label: "Safety Score", primary: "B+", secondary: "79/100", href: "#report-card", colorClass: "text-foreground" }] },
      summary: { title: "USDC summary", text: "Fiat-backed US dollar stablecoin issued by Circle.", updatedAt: "2026-11-20" },
    });
    const { container } = renderDetail(coin);
    expect(followsNode(screen.getByTestId("scrollspy"), screen.getByTestId("ai-summary"))).toBe(true);

    const rail = container.querySelector('aside[aria-label="Coin summary rail"]')!;
    const safety = Array.from(rail.querySelectorAll("h2")).find((h) => h.textContent === "Safety Score")!;
    const contracts = rail.querySelector('[data-anchor-twin="contracts"]')!;
    const keyLinks = rail.querySelector('[aria-label="Key links"]')!;
    const price = rail.querySelector('[data-testid="price-transparency-card"]')!;
    expect(followsNode(safety, contracts) && followsNode(contracts, keyLinks) && followsNode(keyLinks, price)).toBe(true);
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
  });
});

describe("StablecoinDetailClient (frozen)", () => {
  beforeEach(() => { useViewModelMock.mockReset(); });

  it("renders FrozenStateBanner, FrozenDataNote labels, and omits current DEX liquidity while keeping flow history", () => {
    useViewModelMock.mockReturnValue({ ...makeFrozenViewModel(USDS), hasFlows: false, hasFlowHistory: true });
    const { container } = renderDetail();
    expect(screen.getByRole("heading", { name: /Sunset by issuer\./ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /cemetery/i })).toBeTruthy();
    expect(screen.getAllByText(/no longer collects new metrics/i).length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector("#dex-liquidity")).toBeNull();
    expect(container.querySelector("#distribution")).not.toBeNull();
    expect(screen.queryByTestId("contagion-snapshot-mock")).toBeNull();
    expect(screen.getByTestId("flow-history-section")).toBeTruthy();
    expect(screen.queryByTestId("flows-section")).toBeNull();
  });

  it("keeps a frozen archive's past danger notice in its Risk-zone record", () => {
    const frozen = makeFrozenViewModel({ ...USDS, notices: [{ type: "danger", title: "Past halt", message: "M.", kind: "history" }] });
    useViewModelMock.mockReturnValue(frozen);
    renderDetail(frozen.coin);
    expect(screen.getByTestId("notice-stack").textContent).toBe("Past halt");
  });

  it("starts no current summary read for a frozen archive, unlike an active control", () => {
    const frozen = makeFrozenViewModel(USDS);
    useViewModelMock.mockReturnValue(frozen);
    renderDetail(frozen.coin);
    expect(queryClients.at(-1)!.prefetchQuery).not.toHaveBeenCalled();
    mockReady();
    renderDetail();
    expect(queryClients.at(-1)!.prefetchQuery).toHaveBeenCalledTimes(1);
  });

  it("omits active TokenizedFundPanel and tokenized-fund rail copy for a frozen tokenized-fund archive", () => {
    const archive = coinOf("msy-main-street");
    const frozen = makeFrozenViewModel(archive);
    useViewModelMock.mockReturnValue({
      ...frozen,
      hero: {
        ...(frozen.hero as Record<string, unknown>),
        signalRailItems: [{ key: "safety", label: "Safety", primary: "—", secondary: null, href: "#report-card", colorClass: "text-muted-foreground" }],
      },
    });
    const { container } = renderDetail(archive);
    expect(container.querySelector("[data-tokenized-fund-panel]")).toBeNull();
    expect(container.querySelector('[data-safety-state="tokenized-fund"]')).toBeNull();
    expect(container.querySelector('[data-safety-state="frozen"]')).not.toBeNull();
  });

  it("withholds a grade-claiming AI summary for a tokenized fund instead of rendering an NR overall grade", () => {
    const eutbl = coinOf("eutbl-spiko");
    const realSummary = (aiSummaries as Record<string, StablecoinAiSummary>)["eutbl-spiko"];
    expect(realSummary?.claimTokens?.some((token) => token.source === "report-card.grade")).toBe(true);
    const nrCard = makeV9Card({ id: eutbl.id, grade: "NR", score: null, ratingStatus: "not-rated" });
    mockReady({
      id: eutbl.id,
      coin: eutbl,
      summary: realSummary,
      reportCard: nrCard,
      reportCardsResponse: makeReportCardsV9Response({ cards: [nrCard] }),
    });
    const { container } = renderDetail(eutbl, { summary: realSummary });
    expect(screen.queryByTestId("ai-summary")).toBeNull();
    expect(container.textContent).not.toContain("the NR overall grade");
    expect(container.textContent).not.toContain("held down by exit");
  });
});
