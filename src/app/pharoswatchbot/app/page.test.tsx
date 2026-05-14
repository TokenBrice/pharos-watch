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
      body: JSON.stringify({ initData: "signed-init-data" }),
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
      body: JSON.stringify({ initData: "signed-init-data" }),
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

  it("scrolls the targeted coin row into view when launched with coin_<id>", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { start_param: "coin_usdc-circle", user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn() } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      render(<PharosWatchBotMiniAppPage />);

      await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
      // The targeted article has a stable id.
      await waitFor(() => expect(document.getElementById("coin-row-usdc-circle")).toBeTruthy());
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      const target = document.getElementById("coin-row-usdc-circle");
      const lastCall = scrollIntoView.mock.calls.at(-1);
      expect(scrollIntoView.mock.instances.at(-1)).toBe(target);
      expect(lastCall?.[0]).toEqual({ block: "center", behavior: "smooth" });
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("routes quiet-hours start params to settings", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { start_param: "quiet-hours", user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Global alerts")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/telegram-mini-app/session", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data" }),
    }));
  });

  it("routes forget start params to settings", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { start_param: "forget", user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Danger zone")).toBeTruthy();
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

  it("reloads session state after a stale-auth mutation rejection", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() } } };
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "Telegram Mini App session expired", code: "stale-auth" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => staleState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/telegram-mini-app/session",
      "/api/telegram-mini-app/mutate",
      "/api/telegram-mini-app/session",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-global", alertType: "safety", enabled: true } }),
    }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data" }),
    }));
    fireEvent.click(screen.getByRole("tab", { name: "home" }));
    await waitFor(() => expect(screen.getByText("Reopen Telegram to edit settings")).toBeTruthy());
    expect(screen.getByText("Telegram authorization expired. Close and reopen from PharosWatchBot.")).toBeTruthy();
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

  it("dispatches chat-level snooze for 4h", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() } } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Snooze alerts for 4h" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-snooze", durationToken: "4h" } }),
    }));
  });

  it("clears per-coin snooze with the right durationToken", async () => {
    const coinSnoozed: TelegramMiniAppState = {
      ...baseState,
      subscriptions: [
        { ...baseState.subscriptions[0], snoozeUntilTs: 9_000_000_000 },
      ],
    };
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() } } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => coinSnoozed })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear USDC snooze" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "clear" } }),
    }));
  });

  it("dispatches set-timezone from the settings picker", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() } } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Paris" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-timezone", timezone: "Europe/Paris" } }),
    }));
  });

  it("confirms unsubscribe-all once before dispatching", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(true));
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() }, showConfirm } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "unsubscribe-all" } }),
    }));
  });

  it("requires two-step confirmation for forget-me and shows the terminal screen", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(true));
    const close = vi.fn();
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn() }, showConfirm, close } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/telegram-mini-app/mutate", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "forget-me" } }),
    }));
    await waitFor(() => expect(screen.getByText("Your data has been deleted")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close Mini App" }));
    expect(close).toHaveBeenCalled();
  });

  it("uses Telegram confirmation before removing a coin and honors cancel", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(false));
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, showConfirm } };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove USDC" }));

    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requestWriteAccess fires once after recommended-setup for sender chat with no prior subscriber", async () => {
    const requestWriteAccess = vi.fn();
    const isVersionAtLeast = vi.fn((v: string) => v === "6.9" || v === "8.0");
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, isVersionAtLeast, requestWriteAccess } };
    const initialState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, chatType: "sender" },
      subscriber: { ...baseState.subscriber, exists: false },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(requestWriteAccess).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(requestWriteAccess).toHaveBeenCalledTimes(1);
  });

  it("does not fire requestWriteAccess when chat_type is private", async () => {
    const requestWriteAccess = vi.fn();
    const isVersionAtLeast = vi.fn((v: string) => v === "6.9" || v === "8.0");
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, isVersionAtLeast, requestWriteAccess } };
    const initialState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, chatType: "private" },
      subscriber: { ...baseState.subscriber, exists: false },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestWriteAccess).not.toHaveBeenCalled();
  });

  it("probes checkHomeScreenStatus only after first mutation and renders the CTA when missed", async () => {
    const checkHomeScreenStatus = vi.fn((cb: (s: string) => void) => cb("missed"));
    const isVersionAtLeast = vi.fn((v: string) => v === "8.0");
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, isVersionAtLeast, checkHomeScreenStatus } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(checkHomeScreenStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Add to home screen/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checkHomeScreenStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /Add to home screen/i })).toBeTruthy());
  });

  it("hides the Add-to-home-screen CTA when status is added", async () => {
    const checkHomeScreenStatus = vi.fn((cb: (s: string) => void) => cb("added"));
    const isVersionAtLeast = vi.fn((v: string) => v === "8.0");
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, isVersionAtLeast, checkHomeScreenStatus } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checkHomeScreenStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /Add to home screen/i })).toBeNull();
  });

  it("opens Why / Coverage / View-on-Pharos links from a coin card", async () => {
    const openTelegramLink = vi.fn();
    const openLink = vi.fn();
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, openTelegramLink, openLink } };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => baseState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Why USDC" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=why_usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: "Coverage USDC" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=coverage_usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: "View USDC on Pharos" }));
    expect(openLink).toHaveBeenCalledWith("https://pharos.watch/stablecoin/usdc-circle");
  });

  it.each([
    [401, "stale-auth", "Telegram authorization expired. Close and reopen from PharosWatchBot."],
    [409, "replay-claimed", "This Telegram launch was already used. Reopen the Mini App to continue."],
    [429, "rate-limited", "Slow down — Telegram is rate-limiting your edits. Try again in a moment."],
    [403, "not-private", "This Mini App can only edit personal alerts. Use the bot commands in groups."],
    [400, "validation-error", "Change was rejected by the server."],
    [400, "unknown-coin", "Change was rejected by the server."],
    [400, "invalid-timezone", "Change was rejected by the server."],
    [413, "body-too-large", "Request was too large to send."],
    [503, "preset-unavailable", "Mini App backend is temporarily unavailable. Try again shortly."],
    [503, "not-configured", "Mini App backend is temporarily unavailable. Try again shortly."],
    [500, "internal", "Something went wrong. Try again or reopen Telegram."],
  ] as const)("maps mutation status %i / code %s to copy", async (status, code, expected) => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() } } };
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: "x", code }) });
    if (code === "stale-auth") {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => staleState });
    }
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
  });

  it("does not stack MainButton listeners across view transitions", async () => {
    const onClickHandlers: Array<() => void> = [];
    const offClickHandlers: Array<() => void> = [];
    const mainButton = {
      show: vi.fn(),
      hide: vi.fn(),
      setParams: vi.fn(),
      onClick: vi.fn((handler: () => void) => { onClickHandlers.push(handler); }),
      offClick: vi.fn((handler: () => void) => { offClickHandlers.push(handler); }),
    };
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, MainButton: mainButton } };
    // States chosen so MainButton oscillates between handler-attached and no-handler:
    //   1. No subscriber → "Use recommended setup" handler attached.
    //   2. Subscriber active, snooze set → "Clear snooze" handler attached (different identity).
    //   3. Subscriber active, no snooze → no handler.
    const noSubscriberState: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, exists: false, snoozeUntilTs: null },
    };
    const snoozedState: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, exists: true, snoozeUntilTs: 9_000_000_000 },
    };
    const clearedState: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, exists: true, snoozeUntilTs: null },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => noSubscriberState })
      .mockResolvedValueOnce({ ok: true, json: async () => snoozedState })
      .mockResolvedValueOnce({ ok: true, json: async () => clearedState });
    vi.stubGlobal("fetch", fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    await waitFor(() => expect(onClickHandlers.length).toBe(1));

    // Transition 1: trigger a mutation; backend returns snoozed state → handler swaps.
    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClickHandlers.length).toBe(2));

    // Transition 2: trigger another mutation; backend returns cleared state → no handler.
    fireEvent.click(screen.getByRole("button", { name: /Clear snooze/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // After all transitions, every attached handler except (at most) the last
    // must have been detached via offClick.
    const live = onClickHandlers.filter((handler) => !offClickHandlers.includes(handler));
    expect(live.length).toBeLessThanOrEqual(1);
    // Each attached handler should appear at most once in onClickHandlers (no double-attach).
    expect(new Set(onClickHandlers).size).toBe(onClickHandlers.length);
  });

});
