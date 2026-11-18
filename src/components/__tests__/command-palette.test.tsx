// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CommandPalette } from "@/components/command-palette/command-palette-root";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/reference-admission.test-support";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { STABLECOINS_QUERY_KEY } from "@shared/lib/query-keys";
import type { StablecoinListResponse } from "@shared/types/supply";

const {
  pushMock,
  addToHistoryMock,
  clearHistoryMock,
  toggleThemeMock,
  addToWatchlistMock,
  removeFromWatchlistMock,
  clearWatchlistMock,
  useCoinStatesMock,
} = vi.hoisted(() => ({
  useCoinStatesMock: vi.fn(),
  pushMock: vi.fn(),
  addToHistoryMock: vi.fn(),
  clearHistoryMock: vi.fn(),
  toggleThemeMock: vi.fn(),
  addToWatchlistMock: vi.fn(),
  removeFromWatchlistMock: vi.fn(),
  clearWatchlistMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ""} />,
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

vi.mock("@/hooks/use-command-palette-history", () => ({
  useCommandPaletteHistory: () => ({
    history: [],
    addToHistory: addToHistoryMock,
    clearHistory: clearHistoryMock,
  }),
}));

vi.mock("@/hooks/use-theme-toggle", () => ({
  useThemeToggle: () => ({
    isDark: true,
    toggleTheme: toggleThemeMock,
  }),
}));

vi.mock("@/hooks/use-coin-states", () => ({ useCoinStates: useCoinStatesMock }));

vi.mock("@/hooks/use-watchlist", () => ({
  useWatchlist: () => ({
    ids: [],
    add: addToWatchlistMock,
    remove: removeFromWatchlistMock,
    clear: clearWatchlistMock,
    count: 0,
  }),
}));

type StablecoinAsset = StablecoinListResponse["peggedAssets"][number];

function asset(id: string, name: string, symbol: string, price: number, marketCapUsd: number): StablecoinAsset {
  return makeStablecoin({
    id,
    name,
    symbol,
    price,
    circulating: { peggedUSD: marketCapUsd },
  });
}

function stablecoinsPayload(): StablecoinListResponse {
  return {
    peggedAssets: [
      asset("usdt-tether", "Tether", "USDT", 1, 189_000_000_000),
      asset("usdc-circle", "USD Coin", "USDC", 1, 76_000_000_000),
      asset("usds-sky", "Sky Dollar", "USDS", 1, 8_800_000_000),
      asset("susds-sky", "Sky Savings USDS", "sUSDS", 1.09, 6_200_000_000),
      asset("dai-makerdao", "Dai", "DAI", 1, 4_500_000_000),
      asset("syrupusdc-maple", "Maple syrupUSDC", "syrupUSDC", 1.16, 1_400_000_000),
      asset("usdcx-movement", "Movement USDCx", "USDCx", 1, 2_300_000),
    ],
    fxFallbackRates: {},
  };
}

describe("CommandPalette", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    useCoinStatesMock.mockReturnValue({ byId: new Map(), liveReady: true });
    queryClient = new QueryClient();
    queryClient.setQueryData(STABLECOINS_QUERY_KEY, {
      data: stablecoinsPayload(),
      meta: { updatedAt: Date.now() / 1000, ageSeconds: 0, status: "fresh" },
    });
  });

  function renderPalette() {
    return render(
      <QueryClientProvider client={queryClient}>
        <CommandPalette open={true} onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
  }

  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders NAV wrappers with a NAV state instead of an off-peg alert", () => {
    renderPalette();

    const navRow = screen.getByRole("option", {
      name: /Sky Savings USDSsUSDS.*NAV-priced token/i,
    });

    expect(navRow.textContent).toContain("NAV");
  });

  it("names a coin's exceptional state, reading states only while open", () => {
    useCoinStatesMock.mockReturnValue({
      byId: new Map([["usdc-circle", [{ kind: "depeg", deviationBps: -150, ddrTier: null, ddrMethodologyVersion: null }]]]),
      liveReady: true,
    });
    renderPalette();
    expect(useCoinStatesMock).toHaveBeenCalledWith({ enabled: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "USDC" } });
    const depegRow = screen.getByRole("option", { name: /^USD CoinDepeg/i });
    expect(depegRow.querySelector("[data-coin-state=depeg]")?.textContent).toContain("Depeg");
    // Calm coins add nothing: one state, one chip.
    expect(document.querySelectorAll("[data-coin-state]")).toHaveLength(1);
  });

  it.each([["stale-reference", null, "Depeg"], ["admitted", -120, "Depeg · 1.20% below peg"]] as const)(
    "uses the incident's %s severity in the shared state chip", async (status, admittedBps, title) => {
      const { useCoinStates } = await vi.importActual<typeof import("@/hooks/use-coin-states")>("@/hooks/use-coin-states");
      useCoinStatesMock.mockImplementation(useCoinStates);
      const meta = { updatedAt: Date.now() / 1000, ageSeconds: 0, status: "fresh" };
      const { pegSummary, stressSignals, depegResolver } = FRONTEND_API_QUERY_DESCRIPTORS;
      queryClient.setQueryData(pegSummary.queryKey, { meta, data: { coins: [
        { id: "eurc-circle", activeDepeg: true, priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg(status, admittedBps) },
      ] } });
      queryClient.setQueryData(stressSignals.queryKey, { meta, data: { signals: {} } });
      queryClient.setQueryData(depegResolver.queryKey, { meta, data: { rows: [] } });
      renderPalette();
      fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "EURC" } });
      const chip = screen.getByRole("option", { name: /EURCDepeg/ }).querySelector("[data-coin-state=depeg]");
      expect(chip?.getAttribute("title")).toBe(title);
    },
  );

  it("shows live market caps when the stablecoin observer resolves while open", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    queryClient.clear();
    renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "USDC" },
    });
    expect(screen.getByRole("option", { name: /USD CoinUSDC/i }).textContent).not.toContain("$76.00B");

    act(() => {
      queryClient.setQueryData(STABLECOINS_QUERY_KEY, {
        data: stablecoinsPayload(),
        meta: { updatedAt: Date.now() / 1000, ageSeconds: 0, status: "fresh" },
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /USD CoinUSDC/i }).textContent).toContain("$76.00B");
    });
  });

  it("ages an open palette at the producer boundary, dating caps without fetching or disabling navigation", () => {
    vi.useFakeTimers();
    const savedAt = Date.parse("2026-09-06T12:00:00Z");
    vi.setSystemTime(savedAt);
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    queryClient.setQueryData(STABLECOINS_QUERY_KEY, {
      data: stablecoinsPayload(),
      meta: { updatedAt: savedAt / 1000, ageSeconds: 0, status: "fresh", freshBudgetSec: 1, degradedBudgetSec: 2 },
    });
    renderPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "USDC" } });
    expect(screen.getByRole("option", { name: /USD CoinUSDC/i }).textContent).not.toContain("As of");
    const reads = fetch.mock.calls.length;
    act(() => vi.advanceTimersByTime(1001));
    const retained = screen.getByRole("option", { name: /USD CoinUSDC/i });
    expect(retained.textContent).toContain("$76.00B");
    expect(retained.textContent).toContain("As of");
    expect(fetch.mock.calls.length).toBe(reads);
    fireEvent.click(retained);
    expect(pushMock).toHaveBeenCalledWith("/stablecoin/usdc-circle/");
  });

  it("retains dated caps and static search over a failed cached read", () => {
    queryClient.getQueryCache().find({ queryKey: STABLECOINS_QUERY_KEY })!.setState({
      error: new Error("offline"), status: "error",
    });
    renderPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "USDC" } });
    const row = screen.getByRole("option", { name: /USD CoinUSDC/i });
    expect(row.textContent).toContain("As of");
    fireEvent.click(row);
    expect(pushMock).toHaveBeenCalledWith("/stablecoin/usdc-circle/");
  });

  it("keeps static navigation available when the producer clock is missing", () => {
    queryClient.setQueryData(STABLECOINS_QUERY_KEY, { data: stablecoinsPayload(), meta: null });
    renderPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "USDC" } });
    const row = screen.getByRole("option", { name: /USD CoinUSDC/i });
    expect(row.textContent).not.toContain("$76.00B");
    fireEvent.click(row);
    expect(pushMock).toHaveBeenCalledWith("/stablecoin/usdc-circle/");
  });

  it("emits bounded palette_selected analytics on Enter and never the raw query", () => {
    window.gtag = vi.fn();
    renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "USDT" },
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search" }), { key: "Enter" });

    expect(window.gtag).toHaveBeenCalledWith("event", "palette_selected", {
      query_length: 4,
      selected_kind: "stablecoin",
      selected_section: "Stablecoins",
      selected_rank: 0,
    });
    expect(JSON.stringify((window.gtag as Mock).mock.calls)).not.toContain("USDT");
    delete window.gtag;
  });
});
