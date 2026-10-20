// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CommandPalette } from "@/components/command-palette-root";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { STABLECOINS_QUERY_KEY } from "@shared/lib/query-keys";
import type { StablecoinListResponse } from "@shared/types";

const {
  pushMock,
  addToHistoryMock,
  clearHistoryMock,
  toggleThemeMock,
  addToWatchlistMock,
  removeFromWatchlistMock,
  clearWatchlistMock,
} = vi.hoisted(() => ({
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
    expect(navRow.textContent).not.toContain("Off peg");
  });

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
    expect(screen.getByRole("option", { name: /USD CoinUSDC.*At peg/i })).toBeDefined();
    const reads = fetch.mock.calls.length;
    act(() => vi.advanceTimersByTime(1001));
    const retained = screen.getByRole("option", { name: /USD CoinUSDC/i });
    expect(retained.textContent).toContain("$76.00B");
    expect(retained.textContent).toContain("As of");
    expect(retained.textContent).not.toContain("At peg");
    expect(fetch.mock.calls.length).toBe(reads);
    fireEvent.click(retained);
    expect(pushMock).toHaveBeenCalledWith("/stablecoin/usdc-circle/");
  });

  it("does not label a failed cached read at peg, but retains dated caps and static search", () => {
    queryClient.getQueryCache().find({ queryKey: STABLECOINS_QUERY_KEY })!.setState({
      error: new Error("offline"), status: "error",
    });
    renderPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "USDC" } });
    const row = screen.getByRole("option", { name: /USD CoinUSDC/i });
    expect(row.textContent).toContain("As of");
    expect(row.textContent).not.toContain("At peg");
    fireEvent.click(row);
    expect(pushMock).toHaveBeenCalledWith("/stablecoin/usdc-circle/");
  });

  it("keeps static navigation available when the producer clock is missing", () => {
    queryClient.setQueryData(STABLECOINS_QUERY_KEY, { data: stablecoinsPayload(), meta: null });
    renderPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "USDC" } });
    const row = screen.getByRole("option", { name: /USD CoinUSDC/i });
    expect(row.textContent).not.toContain("$76.00B");
    expect(row.textContent).not.toContain("At peg");
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
