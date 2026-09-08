// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
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
      meta: null,
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

  it("keeps rendered search ordering aligned with live market caps", () => {
    renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "USDC" },
    });
    const options = screen.getAllByRole("option");
    const maple = screen.getByRole("option", { name: /Maple syrupUSDC/i });
    const movement = screen.getByRole("option", { name: /Movement USDCx/i });
    expect(options.indexOf(maple)).toBeLessThan(options.indexOf(movement));
  });

  it("keeps static stablecoin search available when the validated list cache is absent", () => {
    queryClient.clear();
    renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "USDCx" },
    });

    expect(screen.getByRole("option", { name: /Movement USDCx/i })).toBeTruthy();
  });

  it("renders a strong page hit above coins whose names merely contain the word", () => {
    renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "api" },
    });
    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent ?? "");

    expect(optionLabels[0]).toContain("API Access");
  });

  it("shows category chips on zero results and navigates on click", () => {
    renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "zzzz-no-such-coin" },
    });

    const chip = screen.getByRole("button", { name: "Stablecoin Directory" });
    fireEvent.click(chip);

    expect(pushMock).toHaveBeenCalledWith("/stablecoins/");
    expect(screen.queryByRole("combobox", { name: "Search" })).toBeTruthy();
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

  it("debounces palette_zero_results for empty result sets", () => {
    vi.useFakeTimers();
    window.gtag = vi.fn();
    const { unmount } = renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "zzzz-no-such-coin" },
    });
    vi.advanceTimersByTime(999);
    expect(window.gtag).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(window.gtag).toHaveBeenCalledWith("event", "palette_zero_results", {
      query_length: 17,
    });

    unmount();
    vi.useRealTimers();
    delete window.gtag;
  });
});
