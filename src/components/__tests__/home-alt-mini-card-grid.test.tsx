// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAltMiniCardGrid } from "@/components/homepage/home-alt-mini-card-grid";
import { DailyDigestCard } from "@/components/home-alt-mini-cards/daily-digest-card";
import { makeStablecoin as makeStablecoinFixture } from "@shared/test-utils/stablecoin";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";

vi.mock("@/components/home-alt-mini-cards/active-depegs-card", () => ({ ActiveDepegsCard: () => <div data-testid="active-depegs-card" /> }));
vi.mock("@/components/home-alt-mini-cards/mint-burn-card", () => ({ MintBurnCard: () => <div data-testid="mint-burn-card" /> }));
vi.mock("@/components/home-alt-mini-cards/peg-health-card", () => ({ PegHealthCard: () => <div data-testid="peg-health-card" /> }));
vi.mock("@/components/home-alt-mini-cards/psi-band-card", () => ({ PsiBandCard: () => <div data-testid="psi-band-card" /> }));
vi.mock("@/components/home-alt-mini-cards/recent-freezes-card", () => ({ RecentFreezesCard: () => <div data-testid="recent-freezes-card" /> }));
vi.mock("@/components/home-alt-mini-cards/supply-moves-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/home-alt-mini-cards/supply-moves-card")>()),
  SupplyMovesCard: () => <div data-testid="supply-moves-card" />,
}));
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));

const hookState = vi.hoisted(() => ({
  peg: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  stablecoins: { data: undefined as unknown, isLoading: false, error: null as Error | null, dataUpdatedAt: 0, meta: undefined as { updatedAt?: number } | undefined },
  blacklistSummary: { data: undefined as unknown, isLoading: false, error: null as Error | null },
}));
vi.mock("@/hooks/api-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/api-hooks")>()),
  usePegSummary: () => hookState.peg,
  useStabilityIndex: () => ({ data: undefined, isLoading: false, error: null, dataUpdatedAt: 0 }),
}));
vi.mock("@/hooks/use-mint-burn-flows", () => ({ useMintBurnFlows: () => ({ data: undefined, isLoading: false, error: null }) }));
vi.mock("@/hooks/use-blacklist-events", () => ({ useBlacklistSummary: () => hookState.blacklistSummary }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: () => hookState.stablecoins }));
vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());

const clients: QueryClient[] = [];
const edition = { digestTitle: "Current headline", editionNumber: 400, generatedAt: 1_700_000_000, slug: "2023-11-14" };
const promo = {
  latest: { ...edition, excerpt: "Current excerpt." },
  previousEditions: [{ ...edition, digestTitle: "Previous headline", editionNumber: 399 }, { ...edition, digestTitle: "Earlier headline", editionNumber: 398 }],
};

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

function makeMovedCoin(id: string, symbol: string, currentSupply: number, previousWeekSupply: number) {
  const nowSec = Math.floor(Date.parse("2026-10-10T12:00:00Z") / 1000);
  return {
    ...makeStablecoinFixture({ id, name: symbol, symbol, pegType: "USD", priceConfidence: "high", circulating: { peggedUSD: currentSupply }, circulatingPrevWeek: { peggedUSD: previousWeekSupply }, circulatingNative: currentSupply, supplyObservedAt: nowSec }),
    supplyChangeBaselines: { week: { observedAt: nowSec - 7 * 86_400, circulatingUsd: previousWeekSupply, circulatingNative: previousWeekSupply } },
  };
}

afterEach(() => {
  hookState.peg = { data: undefined, isLoading: false, error: null };
  hookState.stablecoins = { data: undefined, isLoading: false, error: null, dataUpdatedAt: 0, meta: undefined };
  hookState.blacklistSummary = { data: undefined, isLoading: false, error: null };
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe("HomeAltMiniCardGrid locked layout (Q6/Q7)", () => {
  it("permanently places ActiveDepegsCard in Row 1 alongside PegHealth, PSI, and Mint/Burn without swapping", () => {
    const view = renderWithClient(<HomeAltMiniCardGrid />);
    const rows = screen.getByTestId("desktop-pulse-bento").querySelectorAll(":scope > div.grid");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.firstElementChild?.getAttribute("data-testid")).toBe("active-depegs-card");
    expect(rows[0]!.children[1]?.getAttribute("data-testid")).toBe("peg-health-card");
    expect(rows[1]!.firstElementChild?.getAttribute("data-testid")).toBe("supply-moves-card");
    expect(rows[1]!.lastElementChild?.getAttribute("data-testid")).toBe("recent-freezes-card");
    expect(screen.getAllByTestId("active-depegs-card")).toHaveLength(1);
    expect(screen.queryByText("Daily Digest")).toBeNull();
    view.unmount();
  });

  it("renders a dense mobile 2x3 KPI grid with neutral unavailable placeholders", () => {
    renderWithClient(<HomeAltMiniCardGrid />);
    const mobile = screen.getByTestId("mobile-pulse-kpi-grid");
    const tiles = within(mobile).getAllByRole("link");
    expect(tiles).toHaveLength(6);
    for (const text of ["Active depegs", "Peg health", "Stability Index", "Mint / Burn", "Biggest move (7d)", "Freezable supply", "Updating"]) expect(mobile.textContent).toContain(text);
    expect(tiles[4]!.textContent).toContain("—");
    expect(tiles[5]!.textContent).toContain("—");
    expect(tiles[5]!.textContent).not.toMatch(/0 freezes/);
  });

  it("renders populated Biggest move (7d) and Freezable supply mobile tiles with authoritative counts and singular/plural wording", () => {
    const nowSec = Math.floor(Date.parse("2026-10-10T12:00:00Z") / 1000);
    hookState.stablecoins = {
      data: { peggedAssets: [makeMovedCoin("usdt-tether", "USDT", 55e6, 50e6), makeMovedCoin("usdc-circle", "USDC", 45e6, 40e6), makeMovedCoin("dai-makerdao", "DAI", 33e6, 30e6), makeMovedCoin("usds-sky", "USDS", 22e6, 20e6), makeMovedCoin("pyusd-paypal", "PYUSD", 21e6, 20e6), makeMovedCoin("fdusd-first-digital", "FDUSD", 10e6, 25e6)] },
      isLoading: false, error: null, dataUpdatedAt: nowSec * 1000, meta: { updatedAt: nowSec },
    };
    hookState.blacklistSummary = { data: { stats: { recentFreezeCount24h: 1 } }, isLoading: false, error: null };
    const first = renderWithClient(<HomeAltMiniCardGrid />);
    const mobile = screen.getByTestId("mobile-pulse-kpi-grid");
    const supplyTile = within(mobile).getByRole("link", { name: /Biggest move \(7d\)/ });
    expect(supplyTile.getAttribute("href")).toBe("/flows/");
    expect(supplyTile.textContent).toContain("-60.0%");
    expect(supplyTile.textContent).toContain("FDUSD · 5↑ 1↓");
    const freezeTile = within(mobile).getByRole("link", { name: /Freezable supply/ });
    expect(freezeTile.getAttribute("href")).toBe("/freezewatch/");
    expect(freezeTile.textContent).toContain("%");
    expect(freezeTile.textContent).toContain("1 freeze 24h");
    first.unmount();

    hookState.blacklistSummary = { data: { stats: { recentFreezeCount24h: 24 } }, isLoading: false, error: null };
    const second = renderWithClient(<HomeAltMiniCardGrid />);
    expect(within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Freezable supply/ }).textContent).toContain("24 freezes 24h");
    second.unmount();

    hookState.blacklistSummary = { data: undefined, isLoading: false, error: new Error("503") };
    renderWithClient(<HomeAltMiniCardGrid />);
    const fallbackFreezeTile = within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Freezable supply/ });
    expect(fallbackFreezeTile.textContent).not.toMatch(/0 freezes/);
    expect(fallbackFreezeTile.textContent).toMatch(/Observed supply|Tracked supply/);
  });

  it("distinguishes evaluated zero supply moves from withheld baselines on mobile", () => {
    const nowSec = Math.floor(Date.parse("2026-10-10T12:00:00Z") / 1000);
    hookState.stablecoins = { data: { peggedAssets: [makeMovedCoin("usdc-circle", "USDC", 20e6, 20e6)] }, isLoading: false, error: null, dataUpdatedAt: nowSec * 1000, meta: { updatedAt: nowSec } };
    const flat = renderWithClient(<HomeAltMiniCardGrid />);
    const flatTile = within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Biggest move \(7d\)/ });
    expect(flatTile.textContent).toContain("0%");
    expect(flatTile.textContent).toContain("No 7d moves");
    flat.unmount();

    const withheld = makeMovedCoin("usdc-circle", "USDC", 20e6, 15e6);
    Object.assign(withheld, { supplyChangeBaselines: {} });
    hookState.stablecoins = { data: { peggedAssets: [withheld] }, isLoading: false, error: null, dataUpdatedAt: nowSec * 1000, meta: { updatedAt: nowSec } };
    renderWithClient(<HomeAltMiniCardGrid />);
    const unavailableTile = within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Biggest move \(7d\)/ });
    expect(unavailableTile.textContent).toContain("—");
    expect(unavailableTile.textContent).toContain("Updating");
  });

  it("ranks -50.4 bps ahead of near-par Tier 0 and splits >30d on mobile", () => {
    const D = 86_400, now = 1_700_000_000 + 90 * D;
    const c = (id: string, symbol: string, bps: number) => ({ id, symbol, pegCurrency: "USD", activeDepeg: true, currentDeviationBps: bps });
    const s = (eventId: number, d: number) => ({ eventId, startedAt: now - d * D, escalatedAt: null, coverage: null });
    const tile = () => within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Active depegs/ }).textContent;
    const set = (coins: unknown[], openIncidents: Record<string, unknown>) => {
      hookState.peg = { data: { coins, summary: { activeDepegCount: coins.length, coinsAtPeg: 0, totalTracked: coins.length, medianDeviationBps: 50 }, openIncidents, openIncidentsAsOfSec: now }, isLoading: false, error: null };
    };
    hookState.stablecoins = { data: { peggedAssets: [makeMovedCoin("usdc-circle", "USDC", 500e6, 500e6), makeMovedCoin("usdt-tether", "USDT", 10e6, 10e6), makeMovedCoin("dai-makerdao", "DAI", 900e6, 900e6)] }, isLoading: false, error: null, dataUpdatedAt: now * 1000, meta: { updatedAt: now } };
    set([c("usdc-circle", "USDC", -10), c("usdt-tether", "USDT", -50.4), c("dai-makerdao", "DAI", -2500)], { "usdc-circle": s(1, 2), "usdt-tether": s(2, 3), "dai-makerdao": s(3, 60) });
    const v = renderWithClient(<HomeAltMiniCardGrid />);
    expect(tile()).toMatch(/3· 2 recent.*USDT ↓50 bps · Unconfirmed/);
    set([c("dai-makerdao", "DAI", -2500)], { "dai-makerdao": s(3, 60) });
    v.rerender(<QueryClientProvider client={v.client}><HomeAltMiniCardGrid /></QueryClientProvider>);
    expect(tile()).toMatch(/1· all >30d.*>30d · DAI ↓2500 bps · Unconfirmed/);
    const tFx = FX_REOPEN_QUOTE_AT + 7_141;
    hookState.peg = { data: { coins: [{ id: "eurc-circle", symbol: "EURC", pegCurrency: "EUR", activeDepeg: true, priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg("admitted", 25, FX_REOPEN_QUOTE_AT) }], summary: { activeDepegCount: 1, coinsAtPeg: 0, totalTracked: 1, medianDeviationBps: 25 }, openIncidents: { "eurc-circle": { eventId: 9, startedAt: tFx - 2 * D, escalatedAt: null, coverage: null } }, openIncidentsAsOfSec: tFx }, isLoading: false, error: null };
    v.rerender(<QueryClientProvider client={v.client}><HomeAltMiniCardGrid /></QueryClientProvider>);
    expect(tile()).toContain("Reference not yet updated");
    expect(tile()).not.toContain("Near par");
  });
});

describe("DailyDigestCard full-width editorial strip", () => {
  it("renders the latest edition and dated prior archive leaves without clipping", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    client.setQueryData(["digest-promo"], promo);
    render(<QueryClientProvider client={client}><DailyDigestCard /></QueryClientProvider>);

    expect(screen.getByRole("heading", { name: "Daily Digest" })).toBeTruthy();
    expect(screen.getByText(/Current headline/).textContent).toBe("#400: Current headline");
    expect(screen.getByText(/Previous headline/).textContent).toBe("Nov 14, 2023 · #399: Previous headline");
    expect(screen.getByText(/Earlier headline/).textContent).toBe("Nov 14, 2023 · #398: Earlier headline");
    expect(screen.getByText("Current excerpt.")).toBeTruthy();
  });

  it("keeps unavailable current copy and blank prior leaves without fabricating archive titles", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    client.setQueryData(["digest-promo"], { latest: null, previousEditions: [] });
    render(<QueryClientProvider client={client}><DailyDigestCard /></QueryClientProvider>);

    expect(screen.getByText("Read the latest edition on Telegram")).toBeTruthy();
    expect(screen.queryByText(/Previous headline/)).toBeNull();
    expect(screen.getByRole("link", { name: "Read on Telegram" })).toBeTruthy();
  });
});
