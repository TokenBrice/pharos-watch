// @vitest-environment jsdom

import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { useCallback, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContagionSnapshotMock, createDepegEventsMock, createDetailLazySectionsMock,
  createHeroCardMock, createLogosMock, createNextLinkMock, createNoopComponentMock,
  createStablecoinLogoMock, createViewModelMock, makeFrozenViewModel as mkFrozen, makeReadyViewModel as mkReady,
} from "./client-test-support";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { BRIDGE_TIER_LABELS } from "@shared/lib/classification";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { makeReportCardsV9Response as v9Res, makeV9Card as v9 } from "@/test/fixtures/safety-score-v9";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "@/hooks/__tests__/use-stablecoin-detail-view-model.test-support";
import failureScenarios from "@data/failure-scenarios.json";
import aiSummaries from "@data/ai-summaries.json";
import type { StablecoinAiSummary } from "@shared/types/editorial";
import type { FailureScenariosById } from "@shared/types/failure-scenarios";

const { lazyVP, nearVP, scrollspyMock, useNearMock, useVmMock } = vi.hoisted(() => ({
  lazyVP: [] as boolean[], nearVP: [] as boolean[], scrollspyMock: vi.fn(), useNearMock: vi.fn(), useVmMock: vi.fn(),
}));

vi.mock("./detail-lazy-sections", async () => createDetailLazySectionsMock());
vi.mock("next/link", async () => createNextLinkMock());
vi.mock("@/hooks/use-stablecoin-detail-view-model", () => createViewModelMock(useVmMock));
vi.mock("@/hooks/use-near-viewport", () => ({ useNearViewport: useNearMock }));
vi.mock("@/hooks/use-depeg-events", () => createDepegEventsMock());
vi.mock("@/lib/logos", () => createLogosMock());
vi.mock("@/components/stablecoin-logo", () => createStablecoinLogoMock());
vi.mock("@/components/query-error-notice", () => createNoopComponentMock("QueryErrorNotice"));
vi.mock("@/components/longform-scrollspy-nav", () => ({ LongformScrollspyNav: (p: { className?: string }) => { scrollspyMock(p); return <nav data-testid="scrollspy" className={p.className} />; } }));
vi.mock("@/components/stablecoin-detail/hero-card", () => createHeroCardMock());
vi.mock("@/components/stablecoin-detail/price-transparency-card", () => ({ PriceTransparencyCard: () => <div data-testid="price-transparency-card" /> }));
vi.mock("@/components/stablecoin-detail/redemption-backstop-card", async (origImport) => {
  const o = await origImport<typeof import("@/components/stablecoin-detail/redemption-backstop-card")>();
  return { ...o, RedemptionRouteSection: (p: Parameters<typeof o.RedemptionRouteSection>[0]) => p.entry ? <section data-testid="redemption-route-section" data-freshness-updated-at={p.freshness?.dataUpdatedAt}>{p.entry.stablecoinId}</section> : <o.RedemptionRouteSection {...p} /> };
});
vi.mock("@/hooks/use-blacklist-events", () => ({ useBlacklistSummary: () => ({ data: undefined, dataUpdatedAt: 0 }), useBlacklistEventsPage: () => ({ data: { events: [], total: 0 }, isLoading: false, isError: false }) }));
vi.mock("@/components/ai-summary/ai-summary", async (origImport) => {
  const a = await origImport<typeof import("@/components/ai-summary/ai-summary")>(), { hasAvailableAiSummaryClaims } = await import("@shared/lib/ai-summary-claims");
  return { AiSummary: (p: ComponentProps<typeof a.AiSummary>) => hasAvailableAiSummaryClaims(p.text, p.claimTokens, p.claimValues) ? <div data-testid="ai-summary"><a.AiSummary {...p} /></div> : null };
});
vi.mock("@/components/coin-notice", async (origImport) => ({ ...(await origImport<typeof import("@/components/coin-notice")>()), NoticeStack: ({ notices }: { notices: readonly { title: string }[] }) => notices.length > 0 ? <div data-testid="notice-stack">{notices.map((n) => n.title).join(" | ")}</div> : null }));
vi.mock("@/components/tape/tape-for-coin-teaser", () => createNoopComponentMock("TapeForCoinTeaser"));
vi.mock("@/components/stablecoin-detail/contagion-snapshot", () => createContagionSnapshotMock());

const qClients: QueryClient[] = [];
function render(ui: ReactElement) {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(c, "prefetchQuery").mockResolvedValue(undefined);
  qClients.push(c);
  return rtlRender(ui, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={c}>{children}</QueryClientProvider> });
}

afterEach(() => { for (const c of qClients) c.clear(); qClients.length = 0; });
beforeEach(() => { lazyVP.length = 0; nearVP.length = 0; useNearMock.mockReset().mockImplementation((m?: string) => ({ ref: () => {}, near: useRef((m === "600px" ? nearVP : lazyVP).shift() ?? true).current })); });

const coinOf = (id: string) => TRACKED_META_BY_ID.get(id)!;
const USDS = coinOf("usds-sky"), ID = USDS.id;
const EXPLORE = <section id="explore-next"><h2 id="explore-next-heading">Explore cards</h2></section>;
const PREVIEW = <div data-testid="depeg-history-preview">Latest 6 of 248 archived incidents</div>;
type ExtraProps = Partial<Omit<ComponentProps<typeof StablecoinDetailClient>, "id" | "coin" | "staticCoin">>;

const detailEl = (coin = USDS, extra: ExtraProps = {}) => <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} {...extra} />;
const renderDetail = (coin = USDS, extra: ExtraProps = {}) => render(detailEl(coin, extra));
const mount = (coin = USDS, extra: ExtraProps = {}) => renderDetail(coin, extra).container;
const mockReady = (ov: Parameters<typeof mkReady>[0] = {}) => useVmMock.mockReturnValue(mkReady(ov));
const mockCard = (reportCard: ReturnType<typeof v9>, ov: Parameters<typeof mkReady>[0] = {}) => mockReady({ reportCard, reportCardsResponse: v9Res({ cards: [reportCard] }), ...ov });
const mockFrozen = (coin = USDS, ov: Record<string, unknown> = {}) => { const f = mkFrozen(coin); useVmMock.mockReturnValue({ ...f, ...ov }); return f; };
const mockLoading = () => useVmMock.mockReturnValue({ status: "loading", handleRetryAll: vi.fn() });
const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const q = (c: ParentNode, s: string) => c.querySelector(s);
const qa = (c: ParentNode, s: string) => c.querySelectorAll(s);
const railOf = (c: ParentNode) => q(c, 'aside[aria-label="Coin summary rail"]')!;
const railSlot = (c: ParentNode, s: string) => q(c, `[data-rail-slot="${s}"]`);
const evState = (el: Element | null) => el?.getAttribute("data-evidence-state");
const idxLink = (c: HTMLElement, href: string) => q(c, `[aria-label="Evidence index"] a[href="${href}"]`);
const navSections = () => (scrollspyMock.mock.calls.at(-1)?.[0]?.sections ?? []) as Array<{ id: string; label: string }>;
const fState = (status: string, error: Error | null = null, dataUpdatedAt = 0) => ({ status, dataUpdatedAt, error });
const redFeature = (status: string, err: Error | null = null, at = 0) => ({ ...mkReady().featureStates, redemption: fState(status, err, at) });
const tid = (id: string) => screen.getByTestId(id);
const noTid = (...ids: string[]) => { for (const id of ids) expect(screen.queryByTestId(id)).toBeNull(); };
const hasTid = (...ids: string[]) => { for (const id of ids) expect(tid(id)).toBeTruthy(); };
const lacks = (c: ParentNode, ...parts: string[]) => { for (const p of parts) expect(c.textContent).not.toContain(p); };
const role = (r: string, name: string | RegExp) => screen.getByRole(r, { name });
const qRole = (r: string, name: string | RegExp) => screen.queryByRole(r, { name });
const L_EXP = "Explore cards", L_RETRY_RED = "Retry redemption", RED = "#redemption";
const usdsRed = (score: number | null) => ({ stablecoinId: ID, score, routeFamily: "offchain-issuer" });
const LIVE_COL = { reserves: [{ name: "Vault collateral", pct: 100, risk: "low" }], estimated: false, mode: "live", liveAt: 1_780_000_000, metadata: { collateralizationRatio: 1.24 } };

function mockRedRoute(primaryRoute: string | null, score: number | null) {
  const card = structuredClone(v9({ id: ID })), exit = card.breakdowns!.exit;
  if (primaryRoute === null) exit.primaryRoute = null;
  else Object.assign(exit.primaryRoute!, { key: `redemption:generation:redemption:${primaryRoute}:offchain-issuer`, routeId: `redemption:${primaryRoute}:offchain-issuer`, lane: "redemption" });
  mockCard(card, { redemptionBackstop: usdsRed(score) });
}

describe("StablecoinDetailClient", () => {
  beforeEach(() => { useVmMock.mockReset(); mockReady(); scrollspyMock.mockClear(); });

  it("keeps the retained History preview through loading and list-error, then hands it to the ready dossier", () => {
    const el = () => detailEl(USDS, { depegHistoryPreview: PREVIEW });
    mockLoading();
    const { container: c, rerender } = render(el());
    const check = (outside = false) => {
      expect([screen.getAllByTestId("depeg-history-preview").length, qa(c, "#depeg-history").length]).toEqual([1, 1]);
      if (outside) expect(q(c, "#depeg-history")?.closest("[data-lazy-section]")).toBeNull();
    };
    check(true);
    useVmMock.mockReturnValue({ status: "list-error", listError: new Error("offline"), handleRetryAll: vi.fn() });
    rerender(el());
    check();
    mockReady();
    rerender(el());
    check(true);
  });

  it("keeps the History shell outside the viewport gate with preview, and lazy without preview", () => {
    useNearMock.mockImplementation(() => ({ ref: () => {}, near: false }));
    const { container: c, unmount } = renderDetail(USDS, { depegHistoryPreview: PREVIEW });
    hasTid("depeg-history-preview");
    expect([q(c, "#depeg-history")?.closest("[data-lazy-section]"), qa(c, "[data-lazy-section]").length > 0]).toEqual([null, true]);
    noTid("dews-detail");
    unmount();

    const bare = mount(USDS);
    expect([q(bare, "#depeg-history"), [...bare.querySelectorAll<HTMLElement>("[data-lazy-section]")].some((n) => n.style.minHeight === "390px")]).toEqual([null, true]);
    noTid("history-tabs");
  });

  it("shows a health notice only once detail evidence is past the stale band", () => {
    const now = Date.now(), query = { label: "Detail snapshot", staleTime: 15 * 60_000, hasData: true, dataUpdatedAt: now, error: null, meta: { updatedAt: now / 1000, ageSeconds: 0, status: "fresh" as const, warning: '199 - "Quality drift"' } };
    mockReady({ staleQueries: [query] });
    const { container: c, rerender } = renderDetail();
    expect(q(c, "[data-health-state]")).toBeNull();
    for (const error of [null, new Error("offline")]) {
      mockReady({ staleQueries: [{ ...query, error, meta: { updatedAt: (now - 10 * 3600_000) / 1000, ageSeconds: 36000, status: "stale" as const } }] });
      rerender(detailEl());
      expect([q(c, "[data-health-state]")?.getAttribute("data-health-state"), c.textContent!.includes("Showing an older snapshot")]).toEqual(["stale", true]);
    }
  });

  it.each([[false, false, false, null], [true, false, true, "Yield"], [false, true, true, "Blacklist"], [true, true, true, "Yield & Blacklist"]] as const)(
    "publishes the Activity destination only with content (%s, %s)",
    (hasYieldSection, hasBlacklist, visible, label) => {
      mockReady({ hasFlows: true, hasYieldSection, hasBlacklist, blacklistSymbol: hasBlacklist ? "USDT" : null });
      const c = mount();
      expect([q(c, "#activity") !== null, navSections().find((s) => s.id === "activity")?.label ?? null]).toEqual([visible, label]);
      if (label) expect(q(c, "#activity")?.textContent).toContain(label);
    },
  );

  it("labels #liquidity in searchers' words and opens Risk on #overview with Safety Score ahead of Mechanism", () => {
    mockReady({ hasFlows: true });
    const c = mount(), ov = q(c, "#overview")!;
    expect([navSections().find((s) => s.id === "liquidity")?.label, q(c, "#liquidity")?.textContent?.includes("Supply & Liquidity"), ov.tagName, q(ov, "#overview-heading")?.textContent, ov.contains(q(c, "#report-card")), follows(q(c, "#report-card")!, q(c, "#info")!)])
      .toEqual(["Supply & Liquidity", true, "SECTION", "Risk", true, true]);
  });

  it.each([["with a scenario", true], ["without one", false]] as const)("publishes the How it breaks pill and section only %s", (_l, hasScen) => {
    const sc = (failureScenarios as FailureScenariosById)["crvusd-curve"]!;
    const c = mount(coinOf("crvusd-curve"), { failureScenario: hasScen ? { scenario: sc, isDraft: true } : null });
    const ids = (scrollspyMock.mock.calls[0]?.[0]?.sections ?? []).map((s: { id: string }) => s.id);
    expect([ids.includes("how-it-breaks"), q(c, "#how-it-breaks") !== null]).toEqual([hasScen, hasScen]);
    if (!hasScen) return;
    expect([ids.slice(0, 2), follows(q(c, "#overview")!, q(c, "#how-it-breaks")!), screen.getAllByText("Draft · not approved").length > 0, qa(c, "#failure-scenario details[data-scenario-step]").length])
      .toEqual([["overview", "how-it-breaks"], true, true, sc.stages.length + (sc.branchPoint?.branches.flatMap((b) => b.stages) ?? []).length]);
  });

  it.each([["activity near", [false, true, false], true, true], ["overview near", [true, false, false], true, false], ["all lanes offscreen", [false, false, false], false, false]] as const)(
    "keeps hero and first-fold rail queries eager with %s",
    (_n, near, flows, blacklist) => {
      nearVP.push(...near);
      renderDetail();
      expect(useVmMock).toHaveBeenCalledWith(expect.objectContaining({ supplementalQueryControls: { ...DISABLED_DETAIL_QUERY_CONTROLS, liquidity: true, reportCards: true, redemption: true, yield: true, stress: true, reserves: true, flows, blacklist } }));
    },
  );

  it("prerenders Explore next without a viewport gate, in ready and loading dossier, and drops loading CTA when ready", () => {
    useNearMock.mockImplementation(() => ({ ref: () => {}, near: false }));
    const el = () => detailEl(USDS, { heading: "Sky Dollar (USDS)", exploreNextContent: EXPLORE }), cdp = "Learn how CDP stablecoins work";
    mockLoading();
    const { container: c, rerender } = render(el());
    expect([Boolean(screen.getByText(L_EXP)), qa(c, "h1").length, q(c, "h1")?.textContent, screen.getAllByRole("link", { name: cdp }).length]).toEqual([true, 1, `${USDS.name} (${USDS.symbol})`, 1]);

    mockReady();
    rerender(el());
    const links = screen.getAllByRole("link", { name: cdp });
    expect([screen.getAllByText(L_EXP).length, qa(c, "#explore-next").length, links.length, links[0]!.getAttribute("href")]).toEqual([1, 1, 1, "/learn/mechanisms/cdp/"]);
  });

  it("keeps the canonical mechanism destination in a loading dossier", () => {
    for (const [id, label, href] of [
      ["brz-transfero", "Learn how fiat-backed stablecoins work", "/learn/mechanisms/fiat-cash/"],
      ["susn-noon", "Learn how credit-fund stablecoins work", "/learn/mechanisms/rwa-credit-fund/"],
      ["skymoneyusdtsavings-sky", "Learn how protocol-position stablecoins work", "/learn/mechanisms/protocol-position/"],
    ] as const) {
      mockLoading();
      const { container: c, unmount } = renderDetail(coinOf(id), { exploreNextContent: EXPLORE });
      const link = role("link", label);
      expect([link.getAttribute("href"), link.parentElement?.nextElementSibling, Boolean(screen.getByText(L_EXP))]).toEqual([href, q(c, "#explore-next"), true]);
      unmount();
    }
    mockLoading();
    const c = mount(coinOf("usdr-ring"), { exploreNextContent: EXPLORE });
    expect([qRole("link", /Learn how .* stablecoins work/), q(c, 'a[href^="/learn/mechanisms/"]'), Boolean(screen.getByText(L_EXP))]).toEqual([null, null, true]);
  });

  it("keeps the #contracts destination in the loading dossier from registry deployments", () => {
    mockLoading();
    const { container: c, rerender, unmount } = renderDetail(USDS);
    expect([qa(c, "#contracts").length, c.textContent!.includes("Contract addresses")]).toEqual([1, true]);
    mockReady();
    rerender(detailEl(USDS));
    expect(qa(c, "#contracts")).toHaveLength(1);
    unmount();
    mockLoading();
    expect(q(mount(coinOf("hbd-hive")), "#contracts")).toBeNull();
  });

  it("reserves distant reference islands and keeps one Explore alias set before and after mounting", () => {
    let near = false;
    useNearMock.mockImplementation((m?: string) => ({ ref: () => {}, near: m === "600px" || near }));
    const el = () => detailEl(USDS, { exploreNextContent: EXPLORE }), { container: c, rerender } = render(el());
    for (const id of ["liquidity", "chart", "distribution", "dex-liquidity", "history", "coin-timeline", "explore", "explore-next", "explore-next-heading"]) expect(qa(c, `#${id}`)).toHaveLength(1);
    expect(screen.getAllByTestId("price-transparency-card")).toHaveLength(1);
    near = true;
    rerender(el());
    expect([Boolean(screen.getByText(L_EXP)), qa(c, "#explore-next").length, qa(c, "#explore-next-heading").length]).toEqual([true, 1, 1]);
  });

  it("keeps flows and blacklist children behind their own lazy gates", () => {
    useNearMock.mockImplementation((m?: string) => {
      const [near, setNear] = useState(m === "600px");
      const ref = useCallback((node: HTMLDivElement | null) => {
        if (!node) return;
        const fl = (id: string) => { const d = document.getElementById(id); return d !== null && follows(d, node); };
        setNear(node.style.minHeight !== "440px" && !(node.style.minHeight === "" && fl("activity") && !fl("history")));
      }, []);
      return { ref, near };
    });
    mockReady({ hasFlows: true, hasFlowHistory: true, hasBlacklist: true, blacklistSymbol: "USDT", supplyHistory: [{ date: "2026-01-01", mcap: 100, price: 1, supply: 100 }] });
    renderDetail();
    noTid("flows-section", "blacklist-section");
    hasTid("flow-history-section", "blacklist-history-section");
  });

  it("keeps the collateralization and access rail footprints through pending and populated evidence", () => {
    mockReady({ reportCard: null, reserves: null, featureStates: { redemption: fState("empty"), reserves: fState("loading") } });
    const { container: c, rerender } = renderDetail(), col = railSlot(c, "collateralization")!;
    expect([col.textContent!.includes("Waiting for reserve evidence."), col.className, railSlot(c, "access")]).toEqual([true, "min-h-64", null]);
    lacks(c, "Published access posture is unavailable.");
    mockReady({ reportCard: v9({ id: ID }), reserves: LIVE_COL });
    rerender(detailEl());
    expect([railSlot(c, "collateralization"), col.className, railSlot(c, "access")!.className]).toEqual([col, "", ""]);
  });

  it.each(["empty", "unavailable"])("hides the collateralization rail card once a %s reserve read settles without a KPI", (status) => {
    mockReady({ reportCard: null, reserves: null, featureStates: { redemption: fState("empty"), reserves: fState(status) } });
    const c = mount();
    expect(railSlot(c, "collateralization")).toBeNull();
    lacks(c, "Collateralization evidence is unavailable.");
  });

  it("mounts the reserves module in the score row when report-card data is unavailable", async () => {
    mockReady({ reportCard: null, reserves: { reserves: [{ name: "Curated reserve", pct: 100, risk: "low" }], estimated: false, mode: "curated-fallback" }, refetchReserves: vi.fn().mockResolvedValue({ status: "success" }), isFetchingReserves: true });
    const c = mount(), res = await screen.findByTestId("reserves-section"), ctrl = q(c, "#control-evidence")!;
    noTid("report-card");
    expect([res.textContent!.includes("curated-fallback"), ctrl.contains(res), follows(res, ctrl), role("button", "Retry reserves").hasAttribute("disabled")]).toEqual([true, false, true, true]);
  });

  it("reserves the paired score column only while a saved grade awaits its card, never for coins without one", () => {
    const coin = { ...coinOf("usdt-tether"), reserves: [{ name: "T-Bills", pct: 100, risk: "very-low" as const }], reserveQualitySummary: undefined, reserveLookThrough: undefined };
    const staticCoin = buildStablecoinStaticMeta(coin), card = v9({ id: coin.id });
    const grid = (el: HTMLElement) => q(el, "#report-card")!.parentElement!, slot = (el: HTMLElement) => q(el, "#report-card [data-score-card-placeholder]");
    const renderS = (vm: Record<string, unknown>, rr?: (ui: ReactElement) => void) => { useVmMock.mockReturnValue(vm); const ui = <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={staticCoin} />; return rr ? (rr(ui), null) : render(ui); };

    const { container: c, rerender } = renderS(mkReady({ coin, gradeRead: "pending", hero: { savedGrade: { grade: "C", score: 54, asOfMs: 1_780_000_000_000 }, signalRailItems: [] } }))!;
    expect([grid(c).className.includes("lg:grid-cols-2"), slot(c) !== null]).toEqual([true, true]);

    renderS(mkReady({ coin, reportCard: card, reportCardsResponse: v9Res({ cards: [card] }) }), rerender);
    expect([grid(c).className.includes("lg:grid-cols-2"), slot(c)]).toEqual([true, null]);
    hasTid("report-card");

    for (const vm of [mkReady({ coin, gradeRead: "pending" }), mkReady({ coin, gradeRead: "failed" }), { ...mkFrozen(coin), gradeRead: "pending" }]) {
      renderS(vm, rerender);
      expect([grid(c).className.includes("lg:grid-cols-2"), slot(c)]).toEqual([false, null]);
    }
  });

  it.each([false, true])("mounts #chart for USD assets with supply history (yieldBearing=%s)", (yb) => {
    const coin = yb ? { ...USDS, flags: { ...USDS.flags, yieldBearing: true, navToken: false, pegCurrency: "USD" as const } } : USDS;
    mockReady({ coin, isNavToken: false, supplyHistory: [{ date: "2026-01-01", mcap: 100, price: yb ? 1.01 : 1, supply: yb ? 99 : 100 }] });
    expect(q(mount(coin), "#chart")).toBeTruthy();
    if (!yb) expect(screen.getAllByTestId("dynamic-detail-section").length).toBeGreaterThan(0);
  });

  it("mounts every evidence module once in its board, with rail twins and a complete evidence index", () => {
    mockReady({ reserves: LIVE_COL });
    const c = mount(USDS, { mechanismReview: { archetype: "fiat-cash", reviewedAt: "2026-07-15", notes: "Reserves sit in segregated accounts.", sources: [{ label: "Terms", url: "https://example.com/terms" }] } });
    const [backing, control, mint, rail] = [q(c, "#backing-evidence")!, q(c, "#control-evidence")!, q(c, "#mint-authority"), railOf(c)];
    expect([qa(c, "#mechanism-review").length, q(c, "#info")?.contains(q(c, "#mechanism-review")), backing.contains(q(c, "#mechanism-review")), control.contains(mint), evState(mint)]).toEqual([1, true, false, true, "not-reviewed"]);
    for (const [a, b] of [["collateralization", backing], ["jurisdiction", control]] as const) {
      const owners = qa(c, `#${a}`);
      expect([owners.length, b.contains(owners[0]!), rail.contains(owners[0]!), q(rail, `[data-anchor-twin="${a}"]`) !== null]).toEqual([1, true, false, true]);
    }
    const links = Array.from(qa(rail, '[aria-label="Evidence index"] a')).map((l) => l.getAttribute("href")!);
    expect(links).toEqual(expect.arrayContaining(["#mint-authority", "#bridging"]));
    expect(links).not.toContain("#mechanism-review");
    for (const href of links) { const t = qa(c, href); expect([t.length, rail.contains(t[0]!)]).toEqual([1, false]); }
    expect(rail.textContent).not.toContain("Reserves sit in segregated accounts.");
  });

  it("omits DEWS for NAV tokens, price panel when absent, and bridging for single-chain coins", () => {
    mockReady({ isNavToken: true, coinData: { ...mkReady().coinData, price: null }, dexPriceCheck: null, coin: { ...USDS, contracts: [] } });
    const c = mount({ ...USDS, contracts: [] });
    noTid("dews-detail", "price-transparency-card");
    for (const s of ['[data-evidence-state="not-applicable"]', "#price", "#bridging"]) expect(q(c, s)).toBeNull();
    expect(idxLink(c, "#bridging")).toBeNull();
    lacks(c, BRIDGE_TIER_LABELS["single-chain-or-native"]);
  });

  it("states a missing redemption route in the Exit board and indexes it", () => {
    mockReady({ redemptionBackstop: undefined });
    const c = mount(), red = q(c, RED), row = idxLink(c, RED)?.textContent ?? "";
    expect([q(c, "#exit-evidence")?.contains(red), evState(red), row.includes("Redemption route"), row.includes("Not reviewed")]).toEqual([true, "not-reviewed", true, true]);
  });

  it.each([["deferred", "Waiting for section"], ["loading", "Loading"], ["unavailable", "Unavailable"], ["empty", "Not reviewed"]] as const)(
    "uses the same redemption %s state in the main strip and index",
    (status, label) => {
      const handleRetryAll = vi.fn();
      mockReady({ handleRetryAll, featureStates: redFeature(status, status === "unavailable" ? new Error("offline") : null) });
      const c = mount(), main = q(c, RED)!;
      expect([main.textContent!.includes(label), idxLink(c, RED)!.textContent!.includes(label), evState(main) === "not-reviewed"]).toEqual([true, true, status === "empty"]);
      if (status === "unavailable") { fireEvent.click(role("button", L_RETRY_RED)); expect(handleRetryAll).toHaveBeenCalledOnce(); }
      else expect(qRole("button", L_RETRY_RED)).toBeNull();
    },
  );

  it("preserves a retained redemption route and hands the footer its own health lane", () => {
    const lane = { preset: "redemptionBackstops" as const, dataUpdatedAt: 1_700_000_000_000, error: null, hasData: true, meta: null };
    mockReady({ redemptionBackstop: usdsRed(79), featureStates: redFeature("retained", new Error("offline"), 1), staleQueries: [{ preset: "reportCards", dataUpdatedAt: 1, error: null, hasData: true, meta: null }, lane] });
    const c = mount(), sec = tid("redemption-route-section");
    expect([sec.textContent, sec.getAttribute("data-freshness-updated-at"), idxLink(c, RED)?.textContent?.includes("79"), qRole("button", L_RETRY_RED)]).toEqual([ID, String(lane.dataUpdatedAt), true, null]);
  });

  it("keeps reviewed no-holder evidence authoritative before the live read settles", () => {
    const coin = coinOf("frax-frax");
    mockReady({ id: coin.id, coin, featureStates: redFeature("deferred") });
    const c = mount(coin);
    expect([q(c, RED)?.textContent?.includes("No holder"), idxLink(c, RED)?.textContent?.includes("No holder route")]).toEqual([true, true]);
  });

  it.each([
    ["no route qualifies", null, 79, "not counted"], ["Exit scores this route", ID, 79, null],
    ["Exit scores another coin's route of the same family", "usdc-circle", 79, "not selected"],
    ["Exit selects a colliding route suffix", `other:${ID}`, 79, "not selected"],
    ["Exit selects a composed route suffix", `composed:${ID}`, 79, "not selected"],
    ["unrated & Exit selects another route", "usdc-circle", null, "NR · not selected"],
    ["unrated & no route qualifies", null, null, "NR · not counted"],
  ] as const)("qualifies the indexed redemption score when %s", (_n, primaryRoute, score, note) => {
    mockRedRoute(primaryRoute, score);
    const txt = idxLink(mount(), RED)!.textContent;
    if (score !== null) expect(txt).toContain(String(score));
    if (note) expect(txt).toContain(note);
    else expect(txt).not.toMatch(/not counted|not selected/);
  });

  it.each([
    [`redemption:${ID}:offchain-issuer`, "redemption", "backup"],
    [`redemption:other:${ID}:offchain-issuer`, "redemption", "not selected"],
    [`redemption:${ID}:offchain-issuer`, "dex", "not selected"],
  ] as const)("joins the indexed backup by typed identity (%s, %s)", (routeId, lane, expected) => {
    const card = structuredClone(v9({ id: ID })), key = `redemption:generation:redemption:${ID}:offchain-issuer`;
    card.breakdowns!.exit.diversification = { routeKey: key, routeLabel: "Backup", bonus: 2 };
    card.breakdowns!.exit.alternatives = [{ key, routeId, lane, label: "Backup", routeFamily: "issuer-redemption", score: 70, included: true, exclusionReason: null, confidenceDimensions: null, capacityEvidenceTier: "documented", rawSameNotionalCostBps: null }];
    mockCard(card, { redemptionBackstop: usdsRed(79) });
    expect(idxLink(mount(), RED)!.textContent).toContain(expected);
  });
});

describe("StablecoinDetailClient (frozen S14)", () => {
  beforeEach(() => { useVmMock.mockReset(); });

  it("keeps the reduced dossier: no DEWS, and no placeholder claims a missing review", () => {
    mockFrozen(USDS, { reportCard: v9({ id: ID }) });
    const c = mount();
    noTid("dews-detail");
    expect([q(c, '[data-evidence-state="not-applicable"]'), Array.from(qa(c, '[data-evidence-state="not-reviewed"]')).map((n) => n.id)]).toEqual([null, ["mint-authority"]]);
  });

  it("links no Exit evidence from the Safety Score when the Exit board has no module", () => {
    const { accessPosture } = v9({ id: ID });
    const reportCard = v9({ id: ID, accessPosture: { ...accessPosture, transfer: "unknown", freezeExposure: "unknown", primaryExit: "unknown", governance: "unknown", unknownFields: ["transfer", "freezeExposure", "primaryExit", "governance"] } });
    mockFrozen(USDS, { reportCard, reportCardsResponse: v9Res({ cards: [reportCard] }) });
    const c = mount();
    expect([q(c, "#exit-evidence"), qRole("link", "Exit evidence"), role("link", "Economic Control evidence").getAttribute("href")]).toEqual([null, null, "#control-evidence"]);
  });
});

describe("StablecoinDetailClient lead slot", () => {
  it("orders lead-slot notices around the hero and routes secondary refresh failures to the header ops chip", () => {
    mockReady({
      coin: { ...USDS, notices: [{ type: "warning", title: "Deadline", message: "M.", kind: "deadline", deadline: "2026-11-26" }, { type: "warning", title: "Paused", message: "M.", kind: "paused" }, { type: "danger", title: "Danger", message: "M." }] },
      staleQueries: [{ preset: "yieldRankings", dataUpdatedAt: 0, error: new Error("HTTP 502"), hasData: false, meta: null, secondary: true }],
    });
    renderDetail();
    const stacks = screen.getAllByTestId("notice-stack"), order = [stacks[1]!, tid("hero-card"), stacks[2]!];
    expect([stacks.map((s) => s.textContent), order.slice(1).every((next, i) => follows(order[i]!, next)), q(tid("hero-identity-toolbar"), "[data-secondary-ops-chip][data-health-state='error']")?.textContent?.includes("Partial refresh")])
      .toEqual([["Danger", "Paused", "Deadline"], true, true]);
  });

  it("routes stale restored supply into the header ops chip rather than a top-of-hero banner", () => {
    mockReady({ staleQueries: [{ label: "Supply", secondary: true, staleTime: 600_000, dataUpdatedAt: 1_700_000_000_000, error: null, hasData: true, meta: { updatedAt: 1_700_000_000, ageSeconds: 10_000, status: "stale" } }] });
    const c = mount();
    expect([q(tid("hero-identity-toolbar"), "[data-secondary-ops-chip][data-health-state='stale']")?.textContent?.includes("Older snapshot"), q(c, "[role='status']")]).toEqual([true, null]);
  });

  it("hoists sticky section tabs above AiSummary and prioritizes Contracts and Key links at the top of the rail", () => {
    const coin = coinOf("usdc-circle");
    mockReady({ coin, hero: { signalRailItems: [{ key: "grade", label: "Safety Score", primary: "B+", secondary: "79/100", href: "#report-card", colorClass: "text-foreground" }] }, summary: { title: "USDC summary", text: "Fiat-backed US dollar stablecoin issued by Circle.", updatedAt: "2026-11-20" } });
    const rail = railOf(mount(coin)), safety = Array.from(qa(rail, "h2")).find((h) => h.textContent === "Safety Score")!;
    const [contracts, keyLinks, price] = [q(rail, '[data-anchor-twin="contracts"]')!, q(rail, '[aria-label="Key links"]')!, q(rail, '[data-testid="price-transparency-card"]')!];
    expect([follows(tid("scrollspy"), tid("ai-summary")), follows(safety, contracts), follows(contracts, keyLinks), follows(keyLinks, price), Boolean(role("button", "Report issue"))]).toEqual([true, true, true, true, true]);
  });
});

describe("StablecoinDetailClient (frozen)", () => {
  beforeEach(() => { useVmMock.mockReset(); });

  it("renders FrozenStateBanner, FrozenDataNote labels, and omits current DEX liquidity while keeping flow history", () => {
    mockFrozen(USDS, { hasFlows: false, hasFlowHistory: true });
    const c = mount();
    expect([Boolean(role("heading", /Sunset by issuer\./)), Boolean(role("link", /cemetery/i)), screen.getAllByText(/no longer collects new metrics/i).length >= 3, q(c, "#dex-liquidity"), q(c, "#distribution") !== null]).toEqual([true, true, true, null, true]);
    noTid("contagion-snapshot-mock", "flows-section");
    hasTid("flow-history-section");
  });

  it("keeps a frozen archive's past danger notice in its Risk-zone record", () => {
    renderDetail(mockFrozen({ ...USDS, notices: [{ type: "danger", title: "Past halt", message: "M.", kind: "history" }] }).coin);
    expect(tid("notice-stack").textContent).toBe("Past halt");
  });

  it("starts no current summary read for a frozen archive, unlike an active control", () => {
    renderDetail(mockFrozen().coin);
    expect(qClients.at(-1)!.prefetchQuery).not.toHaveBeenCalled();
    mockReady();
    renderDetail();
    expect(qClients.at(-1)!.prefetchQuery).toHaveBeenCalledTimes(1);
  });

  it("omits active TokenizedFundPanel and tokenized-fund rail copy for a frozen tokenized-fund archive", () => {
    const archive = coinOf("msy-main-street"), f = mkFrozen(archive);
    useVmMock.mockReturnValue({ ...f, hero: { ...(f.hero as Record<string, unknown>), signalRailItems: [{ key: "safety", label: "Safety", primary: "—", secondary: null, href: "#report-card", colorClass: "text-muted-foreground" }] } });
    const c = mount(archive);
    expect([q(c, "[data-tokenized-fund-panel]"), q(c, '[data-safety-state="tokenized-fund"]'), q(c, '[data-safety-state="frozen"]') !== null]).toEqual([null, null, true]);
  });

  it("withholds a grade-claiming AI summary for a tokenized fund instead of rendering an NR overall grade", () => {
    const eutbl = coinOf("eutbl-spiko"), realSummary = (aiSummaries as Record<string, StablecoinAiSummary>)["eutbl-spiko"];
    expect(realSummary?.claimTokens?.some((t) => t.source === "report-card.grade")).toBe(true);
    mockCard(v9({ id: eutbl.id, grade: "NR", score: null, ratingStatus: "not-rated" }), { id: eutbl.id, coin: eutbl, summary: realSummary });
    const c = mount(eutbl, { summary: realSummary });
    noTid("ai-summary");
    lacks(c, "the NR overall grade", "held down by exit");
  });
});
