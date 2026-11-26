// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CommandPalette } from "@/components/command-palette/command-palette-root";
import type { CommandPaletteHistoryItem } from "@/components/command-palette/command-palette-model";
import { CHROME_DISMISS_EVENT, OPEN_KEYBOARD_SHORTCUTS_EVENT } from "@/lib/chrome-popover";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { STABLECOINS_QUERY_KEY } from "@shared/lib/query-keys";
import type { StablecoinListResponse } from "@shared/types/supply";

const {
  pushMock,
  pathnameMock,
  historyMock,
  addToHistoryMock,
  clearHistoryMock,
  toggleThemeMock,
  addToWatchlistMock,
  removeFromWatchlistMock,
  clearWatchlistMock,
  watchlistIdsMock,
  useCoinStatesMock,
} = vi.hoisted(() => ({
  useCoinStatesMock: vi.fn(),
  pushMock: vi.fn(),
  pathnameMock: { current: "/" as string },
  historyMock: { current: [] as CommandPaletteHistoryItem[] },
  addToHistoryMock: vi.fn(),
  clearHistoryMock: vi.fn(),
  toggleThemeMock: vi.fn(),
  addToWatchlistMock: vi.fn(),
  removeFromWatchlistMock: vi.fn(),
  clearWatchlistMock: vi.fn(),
  watchlistIdsMock: { current: [] as string[] },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => pathnameMock.current,
}));

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ""} />,
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

vi.mock("@/hooks/use-command-palette-history", () => ({
  useCommandPaletteHistory: () => ({
    history: historyMock.current,
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
    ids: watchlistIdsMock.current,
    add: addToWatchlistMock,
    remove: removeFromWatchlistMock,
    clear: clearWatchlistMock,
    count: watchlistIdsMock.current.length,
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
    pathnameMock.current = "/";
    historyMock.current = [];
    watchlistIdsMock.current = [];
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

  it("shows compact SafetyGradeBadge inline when grade data is cached", () => {
    queryClient.setQueryData(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.queryKey, {
      data: {
        cards: [
          { id: "usdc-circle", grade: "A", score: 86 },
        ],
      },
      meta: { updatedAt: Date.now() / 1000, ageSeconds: 0, status: "fresh" },
    });
    renderPalette();
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "USDC" } });
    const row = screen.getByRole("option", { name: /USD Coin.*USDC/i });
    expect(row.querySelector('[aria-label="Safety grade A"]')?.textContent).toBe("A");
  });

  it("shows Not graded only for active tokenized funds and suppresses cached grades on inactive funds", () => {
    queryClient.setQueryData(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.queryKey, {
      data: {
        cards: [
          { id: "buidl-blackrock", grade: "NR", score: null },
          { id: "msy-main-street", grade: "B", score: 75 },
          { id: "wtgxx-wisdomtree", grade: "A", score: 85 },
        ],
      },
      meta: { updatedAt: Date.now() / 1000, ageSeconds: 0, status: "fresh" },
    });
    renderPalette();
    const input = screen.getByRole("combobox", { name: "Search" });
    fireEvent.change(input, { target: { value: "BUIDL" } });
    const activeRow = screen.getByRole("option", { name: /BlackRock USD Institutional Digital Liquidity Fund/i });
    expect(activeRow.textContent).toContain("Not graded");
    expect(activeRow.querySelector('[aria-label="Safety grade NR"]')).toBeNull();

    for (const [query, pattern] of [
      ["msy-main-street", /msY/i],
      ["wtgxx-wisdomtree", /WTGXX/i],
    ] as const) {
      fireEvent.change(input, { target: { value: query } });
      const row = screen.getByRole("option", { name: pattern });
      expect(row.textContent).not.toContain("Not graded");
      expect(row.querySelector('[aria-label^="Safety grade"]')).toBeNull();
    }
  });

  it("surfaces route-contextual dossier actions and top verb hint chips", () => {
    pathnameMock.current = "/stablecoin/usdc-circle/";
    renderPalette();

    // Top verb hint chips prefill the search input.
    const compareChip = screen.getByRole("button", { name: "compare" });
    expect(screen.getByRole("button", { name: "portfolio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "reserves" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "depeg" })).toBeTruthy();

    // Dossier route actions render in "This coin".
    fireEvent.click(screen.getByRole("option", { name: /Watch USDC/i }));
    expect(addToWatchlistMock).toHaveBeenCalledWith("usdc-circle");

    fireEvent.click(screen.getByRole("option", { name: /Add USDC to Portfolio/i }));
    expect(pushMock).toHaveBeenCalledWith("/portfolio/?coins=usdc-circle");

    fireEvent.click(screen.getByRole("option", { name: /Compare USDC/i }));
    expect(pushMock).toHaveBeenCalledWith("/compare/?coins=usdc-circle");

    fireEvent.click(screen.getByRole("option", { name: /Alerts for USDC/i }));
    expect(pushMock).toHaveBeenCalledWith("/pharoswatchbot/?coin=usdc-circle");

    fireEvent.click(compareChip);
    expect((screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement).value).toBe("compare ");
  });

  it("routes deep section intents and portfolio watchlist action directly", () => {
    watchlistIdsMock.current = ["usdc-circle", "usds-sky"];
    renderPalette();

    fireEvent.click(screen.getByRole("option", { name: /Open watchlist in Portfolio \(2\)/i }));
    expect(pushMock).toHaveBeenCalledWith("/portfolio/?coins=usdc-circle,usds-sky");

    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "usdc reserves" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search" }), { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/stablecoin/usdc-circle/#reserves");
  });

  it("does not fetch stablecoins while closed", () => {
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchSpy);
    queryClient.clear();

    render(
      <QueryClientProvider client={queryClient}>
        <CommandPalette open={false} onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useCoinStatesMock).toHaveBeenCalledWith({ enabled: false });
  });

  it("lets Enter activate focused non-option buttons, keeps listbox ARIA clean, and shows tablet close", () => {
    historyMock.current = [
      { id: "usdc-circle", type: "stablecoin", label: "USD Coin", sublabel: "USDC", href: "/stablecoin/usdc-circle/" },
    ];
    renderPalette();

    const listbox = screen.getByRole("listbox", { name: "Search results" });
    const clearButton = screen.getByRole("button", { name: "Clear" });
    const closeButton = screen.getByRole("button", { name: "Close command palette" });
    const compareChip = screen.getByRole("button", { name: "compare" });

    // Recent Clear button stays outside role="listbox" while groups sit cleanly inside.
    expect(listbox.contains(clearButton)).toBe(false);
    expect(listbox.querySelectorAll('[role="group"]').length).toBeGreaterThan(0);

    // Top-right close button remains available on touch tablets (<lg), not hidden at sm.
    expect(closeButton.className).toContain("lg:hidden");
    expect(closeButton.className).not.toContain("sm:hidden");

    // Option buttons stay out of Tab order (tabIndex=-1) per WAI-ARIA Combobox APG.
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.getAttribute("tabindex")).toBe("-1");
    }

    // Enter on focused verb chip, Clear, and Close buttons is never hijacked to selectResult().
    for (const btn of [compareChip, clearButton, closeButton]) {
      btn.focus();
      const notPrevented = fireEvent.keyDown(btn, { key: "Enter" });
      expect(notPrevented).toBe(true);
    }
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("dismisses chrome overlays on open, opens keyboard shortcuts from footer, and avoids focus steal on navigation close", () => {
    const dismissSources: string[] = [];
    const onDismiss = (event: Event) => {
      dismissSources.push((event as CustomEvent<{ source: string }>).detail.source);
    };
    let shortcutsOpened = 0;
    const onOpenShortcuts = () => {
      shortcutsOpened += 1;
    };
    window.addEventListener(CHROME_DISMISS_EVENT, onDismiss);
    window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, onOpenShortcuts);

    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const onOpenChange = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <CommandPalette open={true} onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );

    expect(dismissSources).toContain("command-palette");

    // Keyboard shortcuts footer button closes palette and opens the shortcuts dialog without restoring focus to trigger.
    const shortcutsBtn = screen.getByRole("button", { name: /Keyboard shortcuts/i });
    fireEvent.click(shortcutsBtn);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(shortcutsOpened).toBe(1);

    rerender(
      <QueryClientProvider client={queryClient}>
        <CommandPalette open={false} onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );
    expect(document.activeElement).not.toBe(trigger);

    trigger.remove();
    window.removeEventListener(CHROME_DISMISS_EVENT, onDismiss);
    window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, onOpenShortcuts);
  });
});
