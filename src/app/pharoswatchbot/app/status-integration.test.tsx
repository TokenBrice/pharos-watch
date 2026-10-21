// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { installMatchMediaMock } from "@/test-utils/frontend";
import { PharosWatchBotMiniAppClient } from "./client";
import { makeMiniAppState } from "@shared/test-utils/telegram-mini-app-state";
import type { TelegramMiniAppState } from "./types";

const emptyState = makeMiniAppState({
  subscriber: { globalAlerts: { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false } },
  subscriptions: [],
  presets: [],
});

function launch(state: TelegramMiniAppState, nextState = state) {
  installMatchMediaMock();
  window.Telegram = { WebApp: { initData: "signed-init-data", ready: vi.fn(), expand: vi.fn(), initDataUnsafe: { user: { username: "watcher" } } } };
  const operations: unknown[] = [];
  mockFetch([{
    match: "/api/telegram-mini-app/",
    respond: async (request) => {
      if (new URL(request.url).pathname.endsWith("/mutate")) {
        operations.push((await request.json() as { operation: unknown }).operation);
        return { body: nextState };
      }
      return { body: state };
    },
  }], { requireMatch: true });
  render(<PharosWatchBotMiniAppClient />);
  return operations;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  Reflect.deleteProperty(window, "Telegram");
  window.history.replaceState({}, "", "/pharoswatchbot/app/");
});

describe("Mini App confirmed watcher status", () => {
  it.each([
    [emptyState, "Get stablecoin alerts in this chat"],
    [makeMiniAppState({ subscriber: { snoozeUntilTs: 4_102_444_800 } }), "Alerts paused"],
    [makeMiniAppState({ subscriber: { snoozeUntilTs: 9_000_000_000 } }), "Alerts snoozed"],
    [makeMiniAppState({ health: { recentFailureClass: "blocked" } }), "Telegram stopped delivering alerts"],
    [makeMiniAppState(), "Alerts on"],
  ])("classifies the confirmed session as %#: %s", async (state, heading) => {
    launch(state);
    await waitFor(() => expect(screen.getByRole("heading", { name: heading })).toBeTruthy());
    if (heading !== "Alerts on") expect(screen.queryByRole("heading", { name: "Alerts on" })).toBeNull();
  });

  it("stops claiming active alerts after confirmed unsubscribe-all retains the subscriber", async () => {
    const operations = launch(makeMiniAppState(), emptyState);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alerts on" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // Without native confirm sheets the destructive row needs a second tap.
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all alerts" }));
    expect(operations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Tap again to unsubscribe from all" }));
    await waitFor(() => expect(screen.getByText("Unsubscribed from all alerts.")).toBeTruthy());
    expect(operations).toEqual([{ kind: "unsubscribe-all" }]);
    // Delivery history stays visible independently of coverage.
    expect(screen.getByText("Last alert delivered")).toBeTruthy();
  });
});
