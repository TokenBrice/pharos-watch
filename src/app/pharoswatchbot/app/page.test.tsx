// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "Telegram");
});

describe("PharosWatchBotMiniAppPage", () => {
  it("is noindexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("renders browser preview without calling session APIs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PharosWatchBotMiniAppPage />);

    await act(async () => {
      vi.advanceTimersByTime(550);
    });

    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for delayed Telegram launch data before falling back to preview", async () => {
    vi.useFakeTimers();
    const webApp = { initData: "", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() };
    window.Telegram = { WebApp: webApp };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    webApp.initData = "signed-init-data";
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("@watcher")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/telegram-mini-app/session", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", startParam: null }),
    }));
  });

  it("shows a Telegram launch-data error when the bridge exists but initData never arrives", async () => {
    vi.useFakeTimers();
    window.Telegram = { WebApp: { initData: "", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await act(async () => {
      vi.advanceTimersByTime(8_050);
    });

    expect(screen.getByText("Telegram launch data was not available. Close and reopen from PharosWatchBot.")).toBeTruthy();
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
    expect(expand).toHaveBeenCalled();
    expect(screen.getByText("Global alerts")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/telegram-mini-app/session", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", startParam: "settings" }),
    }));
  });

  it("shows authorization-specific copy when the session API rejects initData", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Invalid Telegram Mini App session" }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("Telegram launch authorization was rejected. Close and reopen from PharosWatchBot.")).toBeTruthy());
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

  it("shows stale-auth read-only copy instead of group-only copy", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => staleState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("Reopen Telegram to edit settings")).toBeTruthy());
    expect(screen.queryByText("Group settings are command-only for now")).toBeNull();
  });

  it("posts mutations and replaces returned state", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() } } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...baseState, subscriber: { ...baseState.subscriber, globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } } }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-global", alertType: "safety", enabled: true } }),
    }));
  });

  it("posts global depeg-step mutations from settings", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() } } };
    const nextState: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        globalAlerts: { ...baseState.subscriber.globalAlerts, depegStepBps: 500 },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => nextState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Set global depeg step to 500 bps" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-global-depeg-step", depegStepBps: 500 } }),
    }));
    expect(screen.getByText("500 bps")).toBeTruthy();
  });
});
