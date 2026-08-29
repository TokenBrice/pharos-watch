// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseState } from "../mini-app-test-fixtures";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type { TelegramMiniAppBulkWatchlistResponse } from "../types";
import type { WatchlistPanelProps } from "./WatchlistPanel";
import { WatchlistPanel } from "./WatchlistPanel";

const watchlistState: WatchlistPanelProps["state"] = {
  ...baseState,
  catalog: {
    ...baseState.catalog,
    searchableCoins: [
      ...baseState.catalog.searchableCoins,
      { stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin", peg: "USD" },
    ],
  },
};

function renderWatchlist(overrides: Partial<WatchlistPanelProps> = {}): WatchlistPanelProps {
  const props: WatchlistPanelProps = {
    state: watchlistState,
    canMutate: true,
    canReadBulk: true,
    isMutating: false,
    isRequestBusy: false,
    pendingOperation: null,
    onMutate: vi.fn(),
    onPreviewBulk: async () => null,
    onConfirmBulk: async () => null,
    onUndoBulk: async () => null,
    onRemove: vi.fn(),
    onOpenInsight: vi.fn(),
    pendingUndo: null,
    onUndo: vi.fn(),
    webApp: null,
    nowSec: 1_700_000_000,
    highlightedCoinId: null,
    targetCoinId: null,
    onNavigateToCoin: vi.fn(),
    ...overrides,
  };
  render(<WatchlistPanel {...props} />);
  return props;
}

const bulkPreview: TelegramMiniAppBulkWatchlistResponse = {
  contractVersion: "3",
  catalogVersion: "catalog-v1",
  result: {
    kind: "bulk-watchlist-preview",
    expectedPreferenceGeneration: 2,
    previewFingerprint: "preview-v1-12-deadbeef",
    adds: ["usdt-tether"],
    removes: [],
    unchanged: [],
    sourceImpact: [],
    undo: {
      expectedPreferenceGeneration: 3,
      expectedFingerprint: "preview-v1-12-deadbeef",
      restoreDirectRows: [],
      removeStablecoinIds: ["usdt-tether"],
    },
  },
};

async function applyOneBulkChange(
  onPreviewBulk: ReturnType<typeof vi.fn>,
  onConfirmBulk: ReturnType<typeof vi.fn>,
): Promise<void> {
  fireEvent.change(screen.getByLabelText("Search coins to add in bulk"), { target: { value: "USDT" } });
  fireEvent.click(screen.getAllByRole("checkbox")[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Preview 1 changes" }));
  await waitFor(() => expect(onPreviewBulk).toHaveBeenCalledWith({
    kind: "preview-bulk-watchlist",
    addStablecoinIds: ["usdt-tether"],
    removeStablecoinIds: [],
  }));
  await screen.findByText("Review exact changes");
  fireEvent.click(screen.getByRole("button", { name: "Apply exact changes" }));
  await waitFor(() => expect(onConfirmBulk).toHaveBeenCalledWith({
    kind: "confirm-bulk-watchlist",
    addStablecoinIds: ["usdt-tether"],
    removeStablecoinIds: [],
    expectedPreferenceGeneration: 2,
    previewFingerprint: "preview-v1-12-deadbeef",
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WatchlistPanel", () => {
  it("orders exact search matches first and dispatches follow", () => {
    const onMutate = vi.fn();
    const searchableCoins = [
      ...baseState.catalog.searchableCoins,
      ...Array.from({ length: 8 }, (_, index) => ({
        stablecoinId: `prefix-${index + 1}`,
        symbol: `USDT${index + 1}`,
        name: `USDT ${index + 1}`,
        peg: "USD",
      })),
    ];
    renderWatchlist({
      onMutate,
      state: { ...baseState, catalog: { ...baseState.catalog, searchableCoins } },
    });

    fireEvent.change(screen.getByLabelText("Search stablecoins"), { target: { value: "USDT" } });
    expect(screen.getByText("Showing first 8 of 9")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Follow / })[0]?.getAttribute("aria-label")).toBe("Follow USDT");
    fireEvent.click(screen.getAllByRole("button", { name: /^Follow / })[0]!);
    expect(onMutate).toHaveBeenCalledWith({ kind: "set-coin", stablecoinId: "usdt-tether", patch: { alertTypes: { dews: true, depeg: true } } });
  });

  it("renders launch targets, suggestions, insight actions, and SDK link fallbacks", async () => {
    const onMutate = vi.fn();
    const onOpenInsight = vi.fn();
    const onNavigateToCoin = vi.fn();
    const openLink = vi.fn();
    const webApp: TelegramWebAppSdk = { initData: "signed", openLink };
    renderWatchlist({ onMutate, onOpenInsight, onNavigateToCoin, webApp, targetCoinId: "usdt-tether" });

    expect(screen.getByText("Not in your explicit watchlist.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Follow USDT" }));
    fireEvent.click(screen.getByRole("button", { name: "Why USDT" }));
    fireEvent.click(screen.getByRole("button", { name: "Coverage USDT" }));
    fireEvent.click(screen.getByRole("button", { name: "View USDT on Pharos" }));
    expect(onMutate).toHaveBeenCalledWith({ kind: "set-coin", stablecoinId: "usdt-tether", patch: { alertTypes: { dews: true, depeg: true } } });
    expect(onOpenInsight).toHaveBeenCalledWith({ kind: "why", coinId: "usdt-tether" });
    expect(onOpenInsight).toHaveBeenCalledWith({ kind: "coverage", coinId: "usdt-tether" });
    expect(openLink).toHaveBeenCalledWith("https://pharos.watch/stablecoin/usdt-tether");

    fireEvent.click(screen.getByRole("button", { name: "Go to followed USDC" }));
    fireEvent.click(screen.getByRole("button", { name: "Search for USDT" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Search stablecoins")));
    expect(onNavigateToCoin).toHaveBeenCalledWith("usdc-circle");
  });

  it("keeps suggestion navigation available in a read-only session", async () => {
    const onNavigateToCoin = vi.fn();
    renderWatchlist({ canMutate: false, onNavigateToCoin });

    const followedSuggestion = screen.getByRole("button", { name: "Go to followed USDC" });
    const searchSuggestion = screen.getByRole("button", { name: "Search for USDT" });
    expect(followedSuggestion).toHaveProperty("disabled", false);
    expect(searchSuggestion).toHaveProperty("disabled", false);
    fireEvent.click(followedSuggestion);
    fireEvent.click(searchSuggestion);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Search stablecoins")));
    expect((screen.getByLabelText("Search stablecoins") as HTMLInputElement).value).toBe("USDT");
    expect(onNavigateToCoin).toHaveBeenCalledWith("usdc-circle");
  });

  it("owns row action selection and keeps launch-only rows untunable", () => {
    const onMutate = vi.fn();
    const onRemove = vi.fn();
    const onOpenInsight = vi.fn();
    const onUndo = vi.fn();
    renderWatchlist({ onMutate, onRemove, onOpenInsight, onUndo, pendingUndo: baseState.subscriptions[0]! });

    fireEvent.click(screen.getByRole("button", { name: "USDC Depeg" }));
    fireEvent.click(screen.getByText("Tune USDC").closest("summary")!);
    fireEvent.click(screen.getByRole("button", { name: /\+500 bps/ }));
    fireEvent.click(screen.getByRole("button", { name: "Why USDC" }));
    fireEvent.click(screen.getByRole("button", { name: "Coverage USDC" }));
    fireEvent.click(screen.getByText(/^Snooze USDC/).closest("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Snooze USDC for 4h" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove USDC" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo remove USDC" }));

    expect(onOpenInsight).toHaveBeenNthCalledWith(1, { kind: "why", coinId: "usdc-circle" });
    expect(onOpenInsight).toHaveBeenNthCalledWith(2, { kind: "coverage", coinId: "usdc-circle" });
    expect(onMutate).toHaveBeenCalledWith({ kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { depeg: false } } });
    expect(onMutate).toHaveBeenCalledWith({ kind: "set-coin", stablecoinId: "usdc-circle", patch: { depegStepBps: 500 } });
    expect(onMutate).toHaveBeenCalledWith({ kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "4h" });
    expect(onRemove).toHaveBeenCalledWith(baseState.subscriptions[0]);
    expect(onUndo).toHaveBeenCalledOnce();

    cleanup();
    const coinSnoozed = {
      ...baseState,
      subscriptions: [{ ...baseState.subscriptions[0], snoozeUntilTs: 9_000_000_000 }],
    };
    renderWatchlist({ state: coinSnoozed, onMutate });
    fireEvent.click(screen.getByText(/^Snooze USDC/).closest("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Clear USDC snooze" }));
    expect(onMutate).toHaveBeenLastCalledWith({ kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "clear" });

    cleanup();
    const launchOnly = {
      ...baseState,
      subscriptions: [{ ...baseState.subscriptions[0], alertTypes: { dews: false, depeg: false, safety: false, launch: true, reserve: false, freeze: false }, depegStepBps: null }],
    };
    renderWatchlist({ state: launchOnly });
    expect(screen.getByText("Launch: on/off only. No tuning.")).toBeTruthy();
    expect(screen.queryByText("Tune USDC")).toBeNull();
  });

  it("passes exact bulk preview, confirm, and undo operations", async () => {
    const onPreviewBulk = vi.fn().mockResolvedValue(bulkPreview);
    const onConfirmBulk = vi.fn().mockResolvedValue({ ok: true });
    const onUndoBulk = vi.fn().mockResolvedValue({ ok: true });
    renderWatchlist({ onPreviewBulk, onConfirmBulk, onUndoBulk });

    await applyOneBulkChange(onPreviewBulk, onConfirmBulk);
    expect(screen.getByRole("status").textContent).toContain("Bulk edit applied");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onUndoBulk).toHaveBeenCalledWith({
      kind: "undo-bulk-watchlist",
      expectedPreferenceGeneration: 3,
      expectedFingerprint: "preview-v1-12-deadbeef",
      restoreDirectRows: [],
      removeStablecoinIds: ["usdt-tether"],
    }));
  });

  it("expires the bulk undo affordance after five seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onPreviewBulk = vi.fn().mockResolvedValue(bulkPreview);
    const onConfirmBulk = vi.fn().mockResolvedValue({ ok: true });
    renderWatchlist({ onPreviewBulk, onConfirmBulk });

    await applyOneBulkChange(onPreviewBulk, onConfirmBulk);
    await screen.findByText("Bulk edit applied. Undo is available briefly.");
    await act(async () => { vi.advanceTimersByTime(5_001); });
    await waitFor(() => expect(screen.queryByText("Bulk edit applied. Undo is available briefly.")).toBeNull());
  });
});
