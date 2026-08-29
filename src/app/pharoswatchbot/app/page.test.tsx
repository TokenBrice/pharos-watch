// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
  telegramMiniAppStateRevision,
} from "@shared/lib/telegram-mini-app-contract";
import { isMiniAppErrorCode, miniAppErrorMessage, MINI_APP_ERROR_CODES, MiniAppRequestError } from "./error-messages";
import PharosWatchBotMiniAppPage, { metadata } from "./page";
import { baseState } from "./mini-app-test-fixtures";
import type { TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
import { installMatchMediaMock } from "@/test-utils/frontend";
import { mockFetch } from "@shared/test-utils/mock-fetch";

type MiniAppWebApp = NonNullable<NonNullable<Window["Telegram"]>["WebApp"]>;

interface MiniAppResponseLike {
  ok: boolean;
  status?: number;
  headers?: Headers;
  json(): Promise<unknown>;
}

function isMiniAppResponseLike(value: unknown): value is MiniAppResponseLike {
  return typeof value === "object"
    && value != null
    && "ok" in value
    && typeof value.ok === "boolean"
    && "json" in value
    && typeof value.json === "function";
}

function installMiniAppFetch(fetchImpl: ReturnType<typeof vi.fn>): void {
  mockFetch([{
    match: "/api/telegram-mini-app/",
    respond: async (request) => {
      const url = new URL(request.url);
      const body = request.body == null ? undefined : await request.clone().text();
      const result: unknown = await (fetchImpl as unknown as (
        input: string,
        init: RequestInit,
      ) => Promise<unknown>)(`${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body,
      });
      if (result instanceof Response) return result;
      if (!isMiniAppResponseLike(result)) throw new Error("Mini App fetch fixture must return a response-like value");
      return {
        body: await result.json(),
        status: result.status ?? (result.ok ? 200 : 500),
        headers: result.headers == null ? undefined : Object.fromEntries(result.headers),
      };
    },
  }], { requireMatch: true });
}

function mockStateResponses(...states: TelegramMiniAppState[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const state of states) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => state });
  }
  return fetchMock;
}

/**
 * Collapses the launch preamble shared by the happy-path Mini App tests: a
 * signed Telegram launch for `@watcher`, a stubbed `fetch`, and the render.
 *
 * `launch` shallow-merges over the default bridge (`initDataUnsafe` merges one
 * level deeper so a test can add `start_param` without restating the user), so
 * a test that exercises capability absence simply never passes it. Tests about
 * the launch itself and failing session loads stay hand-written.
 */
function renderMiniApp(options: {
  state?: TelegramMiniAppState;
  launch?: Partial<MiniAppWebApp>;
  fetchImpl?: ReturnType<typeof vi.fn>;
} = {}): ReturnType<typeof vi.fn> {
  const { initDataUnsafe, ...launch } = options.launch ?? {};
  window.Telegram = {
    WebApp: {
      initData: "signed-init-data",
      ready: vi.fn(),
      expand: vi.fn(),
      enableClosingConfirmation: vi.fn(),
      disableClosingConfirmation: vi.fn(),
      HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn() },
      ...launch,
      initDataUnsafe: { user: { username: "watcher" }, ...initDataUnsafe },
    },
  };
  const fetchMock = options.fetchImpl
    ?? vi.fn().mockResolvedValue({ ok: true, json: async () => options.state ?? baseState });
  installMiniAppFetch(fetchMock);
  render(<PharosWatchBotMiniAppPage />);
  return fetchMock;
}

async function renderReadyMiniApp(options: {
  state?: TelegramMiniAppState;
  launch?: Partial<MiniAppWebApp>;
  fetchImpl?: ReturnType<typeof vi.fn>;
} = {}): Promise<ReturnType<typeof vi.fn>> {
  const fetchMock = renderMiniApp(options);
  await waitFor(() => expect(screen.getByRole("tab", { name: "home" })).toBeTruthy());
  return fetchMock;
}

function expectMutationRequest(
  fetchMock: ReturnType<typeof vi.fn>,
  operation: TelegramMiniAppOperation,
  callNumber?: number,
): void {
  const url = expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/);
  const init = expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ initData: "signed-init-data", operation }),
  });
  if (callNumber == null) expect(fetchMock).toHaveBeenLastCalledWith(url, init);
  else expect(fetchMock).toHaveBeenNthCalledWith(callNumber, url, init);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  Reflect.deleteProperty(window, "Telegram");
  window.history.replaceState({}, "", "/pharoswatchbot/app/");
});

describe("PharosWatchBotMiniAppPage", () => {
  it("keeps metadata and the Mini App error-code contract", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    for (const code of MINI_APP_ERROR_CODES) expect(isMiniAppErrorCode(code)).toBe(true);
    expect(isMiniAppErrorCode("empty-alert-types")).toBe(false);
    expect(isMiniAppErrorCode("stale_auth")).toBe(false);
    expect(isMiniAppErrorCode(null)).toBe(false);
    expect(miniAppErrorMessage(new MiniAppRequestError(429, "rate-limited", 12), "mutation"))
      .toBe("Pharos edit limit reached. Wait for the countdown before editing again.");
    expect(miniAppErrorMessage(new MiniAppRequestError(409, "stale-recap-preference"), "mutation"))
      .toBe("Your recap settings changed. Refresh and try again.");
  });

  it("renders browser preview immediately without calling session APIs", () => {
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);

    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for the page script to expose delayed Telegram launch data", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => baseState });
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    const script = document.querySelector<HTMLScriptElement>('script[src="https://telegram.org/js/telegram-web-app.js"]');
    expect(script).toBeTruthy();

    await act(async () => { vi.advanceTimersByTime(600); });
    expect(fetchMock).not.toHaveBeenCalled();

    window.Telegram = {
      WebApp: {
        initData: "signed-init-data",
        platform: "tdesktop",
        initDataUnsafe: { user: { username: "watcher" } },
        ready: vi.fn(),
      },
    };
    await act(async () => {
      script?.dispatchEvent(new Event("load"));
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("@watcher")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/session\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data" }),
    }));
    const sessionUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://pharos.watch");
    expect(sessionUrl.searchParams.get(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM)).toBeTruthy();
    expect(sessionUrl.searchParams.get(TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM)).toBeTruthy();
  });

  it("treats browser-created and unsupported-host SDK objects as preview", () => {
    vi.useFakeTimers();
    window.Telegram = { WebApp: { initData: "", platform: "unknown", ready: vi.fn() } };
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    cleanup();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=unknown");
    window.Telegram = { WebApp: { initData: "signed-init-data", platform: "unknown", ready: vi.fn() } };
    const unsupportedFetch = vi.fn();
    installMiniAppFetch(unsupportedFetch);
    render(<PharosWatchBotMiniAppPage />);
    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(unsupportedFetch).not.toHaveBeenCalled();
  });

  it("offers a bot link or close action when launch data never arrives", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop");
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    await act(async () => { vi.advanceTimersByTime(8_050); });
    expect(screen.getByRole("link", { name: "Open PharosWatchBot" }).getAttribute("href")).toBe("https://t.me/PharosWatchBot");
    expect(fetchMock).not.toHaveBeenCalled();

    cleanup();
    const close = vi.fn();
    window.Telegram = { WebApp: { initData: "", platform: "tdesktop", ready: vi.fn(), close } };
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    await act(async () => { vi.advanceTimersByTime(8_050); });
    expect(screen.getByText("Telegram launch data was not available. Close and reopen from PharosWatchBot.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close and reopen" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the Telegram session and keeps the responsive shell contract", async () => {
    const ready = vi.fn();
    const expand = vi.fn();
    const fetchMock = await renderReadyMiniApp({ launch: { ready, expand } });

    expect(ready).toHaveBeenCalled();
    expect(expand).toHaveBeenCalled();
    expect(screen.getByText("Alerts are active")).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["home", "watchlist", "presets", "settings"]);
    for (const tab of tabs) {
      expect(tab.className).toContain("min-w-0");
      expect(tab.className).toContain("break-words");
      expect(tab.className).toContain("text-xs");
      expect(tab.className).not.toContain("whitespace-nowrap");
      expect(tab.className).not.toContain("truncate");
    }
    expect(screen.getByRole("button", { name: "Refresh session" }).className).toContain("size-11");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/session\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data" }),
    }));
  });

  it("uses Telegram links for privacy when the bridge supports them", async () => {
    const openLink = vi.fn();
    await renderReadyMiniApp({ launch: { openLink } });
    fireEvent.click(screen.getByRole("link", { name: "What we keep" }));
    expect(openLink).toHaveBeenCalledWith(`${window.location.origin}/privacy`);
  });

  it("uses the Telegram first name when no username is available", async () => {
    const state: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, username: null, firstName: "Ada", chatId: "42" },
    };
    await renderReadyMiniApp({ state, launch: { initDataUnsafe: { user: { first_name: "Ada" } } } });
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.queryByText("Chat 42")).toBeNull();
  });

  it("shows authorization copy and retries a failed session load", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "Invalid Telegram Mini App session" }) });
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("Telegram launch authorization was rejected. Close and reopen from PharosWatchBot.")).toBeTruthy());

    cleanup();
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    const retryFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "Unavailable" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    installMiniAppFetch(retryFetch);
    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("Could not load Mini App settings. Reopen from Telegram or try again.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(retryFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["home", null, "Alerts are active"],
    ["watchlist", "coin_usdc-circle", "Add a coin"],
    ["presets", "presets", "Followed presets"],
    ["settings", "settings", "Global alerts"],
    ["quiet-hours", "quiet-hours", "Global alerts"],
    ["forget", "forget", "Danger zone"],
  ] as const)("boots the %s panel through the page router", async (_route, startParam, expected) => {
    await renderReadyMiniApp(startParam == null ? {} : { launch: { initDataUnsafe: { start_param: startParam } } });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it.each([
    ["why_usdc-circle", "Why USDC"],
    ["coverage_usdc-circle", "Coverage USDC"],
    ["why_old-coin", "This launch target is not in the current Mini App catalog. No settings were changed."],
    ["coin_old-coin", "This launch target is not in the current Mini App catalog. No settings were changed."],
  ] as const)("handles %s launch targets without mutating state", async (startParam, expected) => {
    await renderReadyMiniApp({ launch: { initDataUnsafe: { start_param: startParam } } });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("scrolls a catalog deep-link with normal and reduced-motion behavior", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await renderReadyMiniApp({ launch: { initDataUnsafe: { start_param: "coin_usdt-tether" } } });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(document.getElementById("coin-row-usdt-tether")).toBeTruthy();
      expect(screen.getByText("Not in your explicit watchlist.")).toBeTruthy();
      expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById("coin-row-usdt-tether"));
      expect(scrollIntoView.mock.calls.at(-1)?.[0]).toEqual({ block: "center", behavior: "smooth" });

      cleanup();
      const originalMatchMedia = window.matchMedia;
      installMatchMediaMock((query) => query === "(prefers-reduced-motion: reduce)");
      try {
        await renderReadyMiniApp({ launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });
        await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
        expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById("coin-row-usdc-circle"));
        expect(scrollIntoView.mock.calls.at(-1)?.[0]).toEqual({ block: "center", behavior: "auto" });
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("shows stale-auth read-only copy on every panel and preserves relaunch context", async () => {
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };
    const openTelegramLink = vi.fn();
    const impactOccurred = vi.fn();
    await renderReadyMiniApp({
      state: staleState,
      launch: { initDataUnsafe: { start_param: "settings" }, openTelegramLink, HapticFeedback: { impactOccurred } },
    });

    expect(screen.getByText("Reopen Telegram to edit settings")).toBeTruthy();
    expect(screen.getByText("This session is still readable, but edits require a fresh launch from Telegram.")).toBeTruthy();
    expect(screen.queryByText("Group settings are command-only for now")).toBeNull();
    expect(screen.getByRole("button", { name: /Safety/i })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Relaunch and keep this panel" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?startapp=settings");
    expect(impactOccurred).toHaveBeenCalledWith("light");
  });

  it("hides the stale-auth relaunch affordance without openTelegramLink", async () => {
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };
    await renderReadyMiniApp({ state: staleState });
    expect(screen.getByText("Reopen Telegram to edit settings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Relaunch and keep this panel" })).toBeNull();
  });

  it("keeps last-known state read-only through a refresh failure until retry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_725_000_000_000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "offline", code: "internal" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    await renderReadyMiniApp({ fetchImpl: fetchMock });
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));

    const staleHeading = await screen.findByRole("heading", { name: "Showing last-known settings" });
    const stalePanel = staleHeading.closest("section");
    expect(stalePanel).toBeTruthy();
    const { catalog: _catalog, ...mutableState } = baseState;
    expect(within(stalePanel as HTMLElement).getByText(telegramMiniAppStateRevision(mutableState))).toBeTruthy();
    expect(stalePanel?.textContent).toContain("Telegram Mini App auth is temporarily unavailable. Try again shortly.");
    expect(stalePanel?.querySelector("time")?.getAttribute("datetime")).toBe("2024-08-30T06:40:00.000Z");

    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    expect(screen.getByRole("button", { name: /Safety/i })).toHaveProperty("disabled", true);
    fireEvent.click(within(stalePanel as HTMLElement).getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Showing last-known settings" })).toBeNull());
    expect(screen.getByRole("button", { name: /Safety/i })).toHaveProperty("disabled", false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps one successful mutation wired through the page and replaces its visible state", async () => {
    const nextState: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } },
    };
    let resolveMutation!: (response: { ok: true; json: () => Promise<TelegramMiniAppState> }) => void;
    const mutationResponse = new Promise<{ ok: true; json: () => Promise<TelegramMiniAppState> }>((resolve) => {
      resolveMutation = resolve;
    });
    const fetchMock = await renderReadyMiniApp({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => baseState })
        .mockReturnValueOnce(mutationResponse),
    });
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    const safetyToggle = screen.getByRole("button", { name: /Safety/i });
    fireEvent.click(safetyToggle);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(safetyToggle.getAttribute("aria-pressed")).toBe("false");
    expect(safetyToggle.getAttribute("aria-busy")).toBe("true");
    expect(safetyToggle).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Launch/i })).toHaveProperty("disabled", true);
    resolveMutation({ ok: true, json: async () => nextState });
    await waitFor(() => expect(screen.getByRole("button", { name: /Safety/i }).getAttribute("aria-pressed")).toBe("true"));
    expectMutationRequest(fetchMock, { kind: "set-global", alertType: "safety", enabled: true });
  });

  it("keeps one failed mutation wired through the page without changing confirmed state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "x", code: "internal" }) });
    await renderReadyMiniApp({ fetchImpl: fetchMock });
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    const safetyToggle = screen.getByRole("button", { name: /Safety/i });
    fireEvent.click(safetyToggle);
    await waitFor(() => expect(screen.getByText("Something went wrong. Try again or reopen Telegram.")).toBeTruthy());
    expectMutationRequest(fetchMock, { kind: "set-global", alertType: "safety", enabled: true });
    expect(screen.getByRole("button", { name: /Safety/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("renders the terminal screen after forget-me and keeps its close wiring", async () => {
    const showConfirm = vi.fn((_message: string, callback: (confirmed: boolean) => void) => callback(true));
    const close = vi.fn();
    const fetchMock = await renderReadyMiniApp({
      fetchImpl: mockStateResponses(baseState, baseState),
      launch: { showConfirm, close },
    });
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Your data has been deleted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Mini App" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps in-app Why/Coverage views and bot reply fallbacks connected", async () => {
    const openTelegramLink = vi.fn();
    const openLink = vi.fn();
    await renderReadyMiniApp({ launch: { openTelegramLink, openLink } });
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Why USDC" }));
    expect(screen.getByText("Why USDC")).toBeTruthy();
    expect(screen.getByText("Full Safety Score notes are still delivered by the bot reply.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open bot reply" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=why_usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: "Close Why USDC" }));
    fireEvent.click(screen.getByRole("button", { name: "Coverage USDC" }));
    expect(screen.getByText("Alert coverage")).toBeTruthy();
    expect(screen.getByText("DEWS, Depeg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open bot reply" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=coverage_usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: "Close Coverage USDC" }));
    fireEvent.click(screen.getByRole("button", { name: "View USDC on Pharos" }));
    expect(openLink).toHaveBeenCalledWith("https://pharos.watch/stablecoin/usdc-circle");
  });

  it("keeps the sample-alert CTA capability fallback at the client boundary", async () => {
    const openTelegramLink = vi.fn();
    const impactOccurred = vi.fn();
    await renderReadyMiniApp({ launch: { HapticFeedback: { impactOccurred }, openTelegramLink } });
    fireEvent.click(screen.getByRole("button", { name: "Send me a sample alert" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=sample");
    expect(impactOccurred).toHaveBeenCalledWith("light");

    cleanup();
    await renderReadyMiniApp();
    expect(screen.queryByRole("button", { name: "Send me a sample alert" })).toBeNull();
  });

  it("does not stack native MainButton listeners across panel-state transitions", async () => {
    const onClickHandlers: Array<() => void> = [];
    const offClickHandlers: Array<() => void> = [];
    const mainButton = {
      show: vi.fn(),
      hide: vi.fn(),
      setParams: vi.fn(),
      onClick: vi.fn((handler: () => void) => { onClickHandlers.push(handler); }),
      offClick: vi.fn((handler: () => void) => { offClickHandlers.push(handler); }),
    };
    const noSubscriberState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, exists: false, snoozeUntilTs: null } };
    const snoozedState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, exists: true, snoozeUntilTs: 9_000_000_000 } };
    const clearedState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, exists: true, snoozeUntilTs: null } };
    const fetchMock = mockStateResponses(noSubscriberState, snoozedState, clearedState);

    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { MainButton: mainButton } });
    await waitFor(() => expect(onClickHandlers.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(onClickHandlers.length).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Clear snooze/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const live = onClickHandlers.filter((handler) => !offClickHandlers.includes(handler));
    expect(live.length).toBeLessThanOrEqual(1);
    expect(new Set(onClickHandlers).size).toBe(onClickHandlers.length);
  });

  it("hides native MainButton controls for stale-auth read-only sessions", async () => {
    const mainButton = { show: vi.fn(), hide: vi.fn(), setParams: vi.fn(), onClick: vi.fn(), offClick: vi.fn() };
    const readOnlyState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
      subscriber: { ...baseState.subscriber, exists: false, snoozeUntilTs: null },
    };
    await renderReadyMiniApp({ state: readOnlyState, launch: { MainButton: mainButton } });
    expect(mainButton.onClick).not.toHaveBeenCalled();
    expect(mainButton.show).not.toHaveBeenCalled();
    expect(mainButton.hide).toHaveBeenCalled();
  });

  it("guards duplicate native MainButton clicks while its mutation is in flight", async () => {
    const onClickHandlers: Array<() => void> = [];
    const mainButton = {
      show: vi.fn(),
      hide: vi.fn(),
      setParams: vi.fn(),
      onClick: vi.fn((handler: () => void) => { onClickHandlers.push(handler); }),
      offClick: vi.fn(),
    };
    const noSubscriberState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, exists: false, snoozeUntilTs: null } };
    let resolveMutation!: (value: { ok: true; json: () => Promise<TelegramMiniAppState> }) => void;
    const mutationResponse = new Promise<{ ok: true; json: () => Promise<TelegramMiniAppState> }>((resolve) => { resolveMutation = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => noSubscriberState })
      .mockReturnValueOnce(mutationResponse);
    installMiniAppFetch(fetchMock);
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, MainButton: mainButton } };
    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "home" })).toBeTruthy());
    await waitFor(() => expect(onClickHandlers.length).toBe(1));

    act(() => {
      onClickHandlers[0]?.();
      onClickHandlers[0]?.();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveMutation({ ok: true, json: async () => baseState });
    await waitFor(() => expect(screen.getByText("Recommended setup applied.")).toBeTruthy());
  });
});
