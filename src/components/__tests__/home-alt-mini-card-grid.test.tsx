// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAltMiniCardGrid } from "@/components/homepage/home-alt-mini-card-grid";
import { DailyDigestCard } from "@/components/home-alt-mini-cards/daily-digest-card";
import { makeStablecoin as makeStablecoinFixture } from "@shared/test-utils/stablecoin";

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
  stablecoins: {
    data: undefined as unknown,
    isLoading: false,
    error: null as Error | null,
    dataUpdatedAt: 0,
    meta: undefined as { updatedAt?: number } | undefined,
  },
  blacklistSummary: { data: undefined as unknown, isLoading: false, error: null as Error | null },
}));
vi.mock("@/hooks/api-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/api-hooks")>()),
  usePegSummary: () => hookState.peg,
  useStabilityIndex: () => ({ data: undefined, isLoading: false, error: null, dataUpdatedAt: 0 }),
}));
vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnFlows: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistSummary: () => hookState.blacklistSummary,
}));
vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => hookState.stablecoins,
}));
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const clients: QueryClient[] = [];
const edition = { digestTitle: "Current headline", editionNumber: 400, generatedAt: 1_700_000_000, slug: "2023-11-14" };
const promo = {
  latest: { ...edition, excerpt: "Current excerpt." },
  previousEditions: [
    { ...edition, digestTitle: "Previous headline", editionNumber: 399 },
    { ...edition, digestTitle: "Earlier headline", editionNumber: 398 },
  ],
};

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

function makeMovedCoin(id: string, symbol: string, currentSupply: number, previousWeekSupply: number) {
  const nowSec = Math.floor(Date.parse("2026-10-10T12:00:00Z") / 1000);
  return {
    ...makeStablecoinFixture({
      id,
      name: symbol,
      symbol,
      pegType: "USD",
      priceConfidence: "high",
      circulating: { peggedUSD: currentSupply },
      circulatingPrevWeek: { peggedUSD: previousWeekSupply },
      circulatingNative: currentSupply,
      supplyObservedAt: nowSec,
    }),
    supplyChangeBaselines: {
      week: {
        observedAt: nowSec - 7 * 86_400,
        circulatingUsd: previousWeekSupply,
        circulatingNative: previousWeekSupply,
      },
    },
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
    const desktop = screen.getByTestId("desktop-pulse-bento");
    const rows = desktop.querySelectorAll(":scope > div.grid");
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
    expect(mobile.textContent).toContain("Active depegs");
    expect(mobile.textContent).toContain("Peg health");
    expect(mobile.textContent).toContain("Stability Index");
    expect(mobile.textContent).toContain("Mint / Burn");
    expect(mobile.textContent).toContain("Biggest move (7d)");
    expect(mobile.textContent).toContain("Freezable supply");
    expect(mobile.textContent).toContain("Updating");
    expect(tiles[4]!.textContent).toContain("—");
    expect(tiles[5]!.textContent).toContain("—");
    expect(tiles[5]!.textContent).not.toMatch(/0 freezes/);
  });

  it("renders populated Biggest move (7d) and Freezable supply mobile tiles with authoritative counts and singular/plural wording", () => {
    const nowSec = Math.floor(Date.parse("2026-10-10T12:00:00Z") / 1000);
    hookState.stablecoins = {
      data: {
        peggedAssets: [
          makeMovedCoin("usdt-tether", "USDT", 55_000_000, 50_000_000),
          makeMovedCoin("usdc-circle", "USDC", 45_000_000, 40_000_000),
          makeMovedCoin("dai-makerdao", "DAI", 33_000_000, 30_000_000),
          makeMovedCoin("usds-sky", "USDS", 22_000_000, 20_000_000),
          makeMovedCoin("pyusd-paypal", "PYUSD", 21_000_000, 20_000_000),
          makeMovedCoin("fdusd-first-digital", "FDUSD", 10_000_000, 25_000_000),
        ],
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: nowSec * 1000,
      meta: { updatedAt: nowSec },
    };
    hookState.blacklistSummary = {
      data: { stats: { recentFreezeCount24h: 1 } },
      isLoading: false,
      error: null,
    };

    const first = renderWithClient(<HomeAltMiniCardGrid />);
    const mobile = screen.getByTestId("mobile-pulse-kpi-grid");
    const supplyTile = within(mobile).getByRole("link", { name: /Biggest move \(7d\)/ });
    // Authoritative count is 5↑ 1↓ (not capped to desktop's 4-row display slice), peak is FDUSD -60.0%.
    expect(supplyTile.getAttribute("href")).toBe("/flows/");
    expect(supplyTile.textContent).toContain("-60.0%");
    expect(supplyTile.textContent).toContain("FDUSD · 5↑ 1↓");

    const freezeTile = within(mobile).getByRole("link", { name: /Freezable supply/ });
    expect(freezeTile.getAttribute("href")).toBe("/freezewatch/");
    expect(freezeTile.textContent).toContain("%");
    expect(freezeTile.textContent).toContain("1 freeze 24h");
    first.unmount();

    hookState.blacklistSummary = {
      data: { stats: { recentFreezeCount24h: 24 } },
      isLoading: false,
      error: null,
    };
    const second = renderWithClient(<HomeAltMiniCardGrid />);
    const pluralTile = within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Freezable supply/ });
    expect(pluralTile.textContent).toContain("24 freezes 24h");
    second.unmount();

    // Unavailable freeze summary must never fabricate "0 freezes 24h".
    hookState.blacklistSummary = { data: undefined, isLoading: false, error: new Error("503") };
    renderWithClient(<HomeAltMiniCardGrid />);
    const fallbackFreezeTile = within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Freezable supply/ });
    expect(fallbackFreezeTile.textContent).not.toMatch(/0 freezes/);
    expect(fallbackFreezeTile.textContent).toMatch(/Observed supply|Tracked supply/);
  });

  it("distinguishes evaluated zero supply moves from withheld baselines on mobile", () => {
    const nowSec = Math.floor(Date.parse("2026-10-10T12:00:00Z") / 1000);
    hookState.stablecoins = {
      data: {
        peggedAssets: [makeMovedCoin("usdc-circle", "USDC", 20_000_000, 20_000_000)],
      },
      isLoading: false,
      error: null,
      dataUpdatedAt: nowSec * 1000,
      meta: { updatedAt: nowSec },
    };
    const flat = renderWithClient(<HomeAltMiniCardGrid />);
    const flatTile = within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Biggest move \(7d\)/ });
    expect(flatTile.textContent).toContain("0%");
    expect(flatTile.textContent).toContain("No 7d moves");
    flat.unmount();

    const withheld = makeMovedCoin("usdc-circle", "USDC", 20_000_000, 15_000_000);
    Object.assign(withheld, { supplyChangeBaselines: {} });
    hookState.stablecoins = {
      data: { peggedAssets: [withheld] },
      isLoading: false,
      error: null,
      dataUpdatedAt: nowSec * 1000,
      meta: { updatedAt: nowSec },
    };
    renderWithClient(<HomeAltMiniCardGrid />);
    const unavailableTile = within(screen.getByTestId("mobile-pulse-kpi-grid")).getByRole("link", { name: /Biggest move \(7d\)/ });
    expect(unavailableTile.textContent).toContain("—");
    expect(unavailableTile.textContent).toContain("Updating");
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
