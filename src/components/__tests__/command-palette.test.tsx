// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
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
    cleanup();
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
    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent ?? "");

    expect(optionLabels.findIndex((label) => label.includes("Maple syrupUSDC"))).toBeLessThan(
      optionLabels.findIndex((label) => label.includes("Movement USDCx")),
    );
  });

  it("keeps static stablecoin search available when the validated list cache is absent", () => {
    queryClient.clear();
    renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "USDCx" },
    });

    expect(screen.getByRole("option", { name: /Movement USDCx/i })).toBeTruthy();
  });
});
