// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PharosWatchBotMiniAppPage, { metadata } from "./page";
import type { TelegramMiniAppState } from "./types";

const baseState: TelegramMiniAppState = {
  viewer: { userId: "42", username: "watcher", chatId: "42", chatType: "private", canMutate: true, mutationBlockReason: null },
  subscriber: {
    exists: true,
    globalAlerts: { dews: true, depeg: true, safety: false, launch: false, depegStepBps: 250 },
    quietHours: { enabled: false, startHourUtc: null, endHourUtc: null, timezone: "UTC" },
    snoozeUntilTs: null,
  },
  presets: [],
  subscriptions: [
    { stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin", alertTypes: { dews: true, depeg: true, safety: false, launch: false }, dewsMinBand: "ALERT", depegStepBps: 250, safetyMode: null, snoozeUntilTs: null },
  ],
  catalog: {
    recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }],
    searchableCoins: [{ stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether", peg: "USD" }],
  },
  health: { lastSuccessfulDeliveryAt: 1_700_000_000, lastSuccessfulReplyAt: 1_700_000_100, queuedAlerts: 0, recentFailureClass: null },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "Telegram");
});

describe("PharosWatchBotMiniAppPage", () => {
  it("is noindexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("renders browser preview without calling session APIs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    expect(await screen.findByText("PharosWatchBot app preview")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads Telegram session state", async () => {
    const ready = vi.fn();
    const expand = vi.fn();
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" }, start_param: "settings" }, ready, expand } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(ready).toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();
    expect(screen.getByText("Global alerts")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/telegram-mini-app/session", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", startParam: "settings" }),
    }));
  });

  it("routes coin start params to the watchlist view", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { start_param: "coin_usdc-circle", user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Add a coin")).toBeTruthy();
    expect(screen.getByText(/Launch intent:/)).toBeTruthy();
  });

  it("posts mutations and replaces returned state", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() } } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...baseState, subscriber: { ...baseState.subscriber, globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } } }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-global", alertType: "safety", enabled: true } }),
    }));
  });
});
