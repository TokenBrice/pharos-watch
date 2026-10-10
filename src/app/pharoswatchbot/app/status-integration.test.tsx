// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { installMatchMediaMock } from "@/test-utils/frontend";
import { PharosWatchBotMiniAppClient } from "./client";
import { makeMiniAppState } from "./mini-app-test-fixtures";
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
    [emptyState, "No enabled alerts"],
    [makeMiniAppState({ subscriber: { snoozeUntilTs: 4_102_444_800 } }), "Alerts are paused indefinitely"],
    [makeMiniAppState({ subscriber: { snoozeUntilTs: 9_000_000_000 } }), "Alerts are temporarily snoozed"],
    [makeMiniAppState(), "Alerts are active"],
  ])("classifies the confirmed session as %s", async (state, heading) => {
    launch(state);
    await waitFor(() => expect(screen.getByRole("heading", { name: heading })).toBeTruthy());
    if (heading !== "Alerts are active") expect(screen.queryByRole("heading", { name: "Alerts are active" })).toBeNull();
  });

  it("stops claiming active alerts after confirmed unsubscribe-all retains the subscriber", async () => {
    const operations = launch(makeMiniAppState(), emptyState);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alerts are active" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unsubscribe from all alerts" }));
    await waitFor(() => expect(screen.getByText("All subscriptions cleared.")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "home" }));
    expect(screen.getByRole("heading", { name: "No enabled alerts" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Alerts are active" })).toBeNull();
    expect(operations).toEqual([{ kind: "unsubscribe-all" }]);
    expect(screen.getByText("Last delivery")).toBeTruthy();
  });
});
