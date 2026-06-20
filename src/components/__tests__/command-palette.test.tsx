// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/command-palette";
import { makeStablecoin } from "@/test/fixtures/safety-scores";
import type { StablecoinListResponse } from "@shared/types";

const {
  pushMock,
  useStablecoinsMock,
  addToHistoryMock,
  clearHistoryMock,
  toggleThemeMock,
  addToWatchlistMock,
  removeFromWatchlistMock,
  clearWatchlistMock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
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

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
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
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    useStablecoinsMock.mockReturnValue({ data: stablecoinsPayload() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders NAV wrappers with a NAV state instead of an off-peg alert", () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    const navRow = screen.getByRole("option", {
      name: /Sky Savings USDSsUSDS.*NAV-priced token/i,
    });

    expect(navRow.textContent).toContain("NAV");
    expect(navRow.textContent).not.toContain("Off peg");
  });

  it("keeps rendered search ordering aligned with live market caps", () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "USDC" },
    });
    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent ?? "");

    expect(optionLabels.findIndex((label) => label.includes("Maple syrupUSDC"))).toBeLessThan(
      optionLabels.findIndex((label) => label.includes("Movement USDCx")),
    );
  });
});
