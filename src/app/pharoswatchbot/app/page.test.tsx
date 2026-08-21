// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
  createTelegramMiniAppSnapshot,
  telegramMiniAppStateRevision,
  type TelegramMiniAppMutableState,
} from "@shared/lib/telegram-mini-app-contract";
import { isMiniAppErrorCode, miniAppErrorMessage, MINI_APP_ERROR_CODES, MiniAppRequestError } from "./error-messages";
import { refreshMiniAppBundleOnce } from "./mini-app-api";
import PharosWatchBotMiniAppPage, { metadata } from "./page";
import type { TelegramMiniAppState } from "./types";
import { installMatchMediaMock } from "@/test-utils/frontend";
import { mockFetch } from "@shared/test-utils/mock-fetch";

const baseState: TelegramMiniAppState = {
  viewer: { userId: "42", username: "watcher", chatId: "42", chatType: "private", canMutate: true, mutationBlockReason: null },
  subscriber: {
    exists: true,
    globalAlerts: { dews: true, depeg: true, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: 250 },
    quietHours: { enabled: false, startHourUtc: null, endHourUtc: null, timezone: "UTC" },
    recap: { available: true, enabled: false, deliveryHourLocal: 9, timezoneConfirmed: true, nextDueAt: null, lastWindowEndAt: null, lastDeliveredLocalDate: null, lastOutcome: null },
    snoozeUntilTs: null,
  },
  presets: [],
  subscriptions: [
    { stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin", alertTypes: { dews: true, depeg: true, safety: false, launch: false, reserve: false, freeze: false }, dewsMinBand: "ALERT", depegStepBps: 250, safetyMode: null, snoozeUntilTs: null },
  ],
  catalog: {
    recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }],
    searchableCoins: [{ stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether", peg: "USD" }],
  },
  health: { lastSuccessfulDeliveryAt: 1_700_000_000, lastSuccessfulReplyAt: 1_700_000_100, queuedAlerts: 0, recentFailureClass: null },
};

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

/**
 * Collapses the launch preamble shared by the happy-path Mini App tests: a
 * signed Telegram launch for `@watcher`, a stubbed `fetch`, and the render.
 *
 * `launch` shallow-merges over the default bridge (`initDataUnsafe` merges one
 * level deeper so a test can add `start_param` without restating the user), so
 * a test that exercises capability *absence* — `openTelegramLink`,
 * `showConfirm`, `MainButton` — simply never passes it. Tests about the launch
 * itself (missing bridge, empty `initData`, hash launch params, delayed SDK
 * script, unsupported host) and about a failing session load stay hand-written.
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
  it("is noindexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("accepts only declared Mini App error codes", () => {
    for (const code of MINI_APP_ERROR_CODES) {
      expect(isMiniAppErrorCode(code)).toBe(true);
    }

    expect(isMiniAppErrorCode("empty-alert-types")).toBe(false);
    expect(isMiniAppErrorCode("stale_auth")).toBe(false);
    expect(isMiniAppErrorCode(null)).toBe(false);
  });

  it("attributes edit throttling to Pharos rather than Telegram", () => {
    expect(miniAppErrorMessage(
      new MiniAppRequestError(429, "rate-limited", 12),
      "mutation",
    )).toBe("Pharos edit limit reached. Wait for the countdown before editing again.");
  });

  it("asks the user to retry a recap write rejected by a generation fence", () => {
    expect(miniAppErrorMessage(
      new MiniAppRequestError(409, "stale-recap-preference"),
      "mutation",
    )).toBe("Your recap settings changed. Refresh and try again.");
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

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
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

  it("treats the SDK object created in a normal browser as standalone", () => {
    vi.useFakeTimers();
    window.Telegram = { WebApp: { initData: "", platform: "unknown", ready: vi.fn() } };
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats launch data from an unsupported host as browser preview", () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=unknown");
    window.Telegram = {
      WebApp: {
        initData: "signed-init-data",
        platform: "unknown",
        initDataUnsafe: { user: { username: "watcher" } },
        ready: vi.fn(),
      },
    };
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a bot link when missing launch data cannot close a WebView", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop");
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await act(async () => {
      vi.advanceTimersByTime(8_050);
    });

    expect(screen.getByRole("link", { name: "Open PharosWatchBot" }).getAttribute("href")).toBe("https://t.me/PharosWatchBot");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes a supported Telegram launch when initData never arrives", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop");
    const close = vi.fn();
    window.Telegram = { WebApp: { initData: "", platform: "tdesktop", ready: vi.fn(), close } };
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await act(async () => {
      vi.advanceTimersByTime(8_050);
    });

    expect(screen.getByText("Telegram launch data was not available. Close and reopen from PharosWatchBot.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close and reopen" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads Telegram session state", async () => {
    const ready = vi.fn();
    const expand = vi.fn();

    const fetchMock = renderMiniApp({ launch: { initDataUnsafe: { start_param: "settings" }, ready, expand } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(ready).toHaveBeenCalled();
    expect(expand).toHaveBeenCalled();
    expect(screen.getByText("Global alerts")).toBeTruthy();
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

  it("opens the privacy notice through Telegram when the bridge supports links", async () => {
    const openLink = vi.fn();
    renderMiniApp({ launch: { openLink } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "What we keep" }));
    expect(openLink).toHaveBeenCalledWith(`${window.location.origin}/privacy`);
  });

  it("uses the Telegram first name when no username is available", async () => {
    const state: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, username: null, firstName: "Ada", chatId: "42" },
    };

    renderMiniApp({ state, launch: { initDataUnsafe: { user: { first_name: "Ada" } } } });

    await waitFor(() => expect(screen.getByText("Ada")).toBeTruthy());
    expect(screen.queryByText("Chat 42")).toBeNull();
  });

  it("shows authorization-specific copy when the session API rejects initData", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Invalid Telegram Mini App session" }) });
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("Telegram launch authorization was rejected. Close and reopen from PharosWatchBot.")).toBeTruthy());
  });

  it("retries a failed session request when launch data is available", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "Unavailable" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);

    await waitFor(() => expect(screen.getByText("Could not load Mini App settings. Reopen from Telegram or try again.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("routes coin start params to the watchlist view", async () => {
    renderMiniApp({ launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Add a coin")).toBeTruthy();
    // The raw launch-intent payload echo was removed deliberately — deep links
    // should route silently to the right view.
    expect(screen.queryByText(/Launch intent:/)).toBeNull();
  });

  it("routes why start params to an in-app insight view", async () => {
    renderMiniApp({ launch: { initDataUnsafe: { start_param: "why_usdc-circle" } } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Why USDC")).toBeTruthy();
    expect(screen.getByText("Full Safety Score notes are still delivered by the bot reply.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open bot reply" })).toBeTruthy();
  });

  it("routes coverage start params to an in-app insight view", async () => {
    renderMiniApp({ launch: { initDataUnsafe: { start_param: "coverage_usdc-circle" } } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Coverage USDC")).toBeTruthy();
    expect(screen.getByText("Alert coverage")).toBeTruthy();
    expect(screen.getByText("DEWS, Depeg")).toBeTruthy();
  });

  it("falls through safely for stale insight start params", async () => {
    renderMiniApp({ launch: { initDataUnsafe: { start_param: "why_old-coin" } } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Why old-coin")).toBeTruthy();
    expect(screen.getByText("This launch target is not in the current Mini App catalog. No settings were changed.")).toBeTruthy();
  });

  it("scrolls the targeted coin row into view when launched with coin_<id>", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      renderMiniApp({ launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });

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

  it("uses instant deep-link scroll when reduced motion is requested", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const originalMatchMedia = window.matchMedia;
    Element.prototype.scrollIntoView = scrollIntoView;
    installMatchMediaMock((query) => query === "(prefers-reduced-motion: reduce)");

    try {
      renderMiniApp({ launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });

      await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(scrollIntoView.mock.calls.at(-1)?.[0]).toEqual({ block: "center", behavior: "auto" });
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
      window.matchMedia = originalMatchMedia;
    }
  });

  it("renders and scrolls a catalog launch target that is not yet followed", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      renderMiniApp({ launch: { initDataUnsafe: { start_param: "coin_usdt-tether" } } });

      await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
      await waitFor(() => expect(document.getElementById("coin-row-usdt-tether")).toBeTruthy());
      expect(screen.getByText("Not in your explicit watchlist.")).toBeTruthy();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(scrollIntoView.mock.instances.at(-1)).toBe(document.getElementById("coin-row-usdt-tether"));
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("renders a no-change fallback for stale coin launch targets", async () => {
    renderMiniApp({ launch: { initDataUnsafe: { start_param: "coin_old-coin" } } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("This launch target is not in the current Mini App catalog. No settings were changed.")).toBeTruthy();
  });

  it("routes quiet-hours start params to settings", async () => {
    const fetchMock = renderMiniApp({ launch: { initDataUnsafe: { start_param: "quiet-hours" } } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Global alerts")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/session\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data" }),
    }));
  });

  it("routes forget start params to settings", async () => {
    renderMiniApp({ launch: { initDataUnsafe: { start_param: "forget" } } });

    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Danger zone")).toBeTruthy();
  });

  it("shows stale-auth read-only copy instead of group-only copy", async () => {
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };

    renderMiniApp({ state: staleState });

    await waitFor(() => expect(screen.getByText("Reopen Telegram to edit settings")).toBeTruthy());
    expect(screen.queryByText("Group settings are command-only for now")).toBeNull();
  });

  it("keeps stale-auth read-only copy visible outside the home tab", async () => {
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };

    renderMiniApp({ state: staleState, launch: { initDataUnsafe: { start_param: "settings" } } });

    await waitFor(() => expect(screen.getByText("Global alerts")).toBeTruthy());
    expect(screen.getAllByText("Reopen Telegram to edit settings")).toHaveLength(1);
    expect(screen.getByText("This session is still readable, but edits require a fresh launch from Telegram.")).toBeTruthy();
    expect(screen.queryByText("Group settings are command-only for now")).toBeNull();
  });

  it("offers a Telegram relaunch that reopens the current panel on stale auth", async () => {
    const openTelegramLink = vi.fn();
    const impactOccurred = vi.fn();
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };

    renderMiniApp({
      state: staleState,
      launch: { initDataUnsafe: { start_param: "settings" }, HapticFeedback: { impactOccurred }, openTelegramLink },
    });

    await waitFor(() => expect(screen.getByText("Reopen Telegram to edit settings")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Relaunch and keep this panel" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?startapp=settings");
    expect(impactOccurred).toHaveBeenCalledWith("light");
  });

  it("hides the stale-auth relaunch button when openTelegramLink is unavailable", async () => {
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };

    renderMiniApp({ state: staleState });

    await waitFor(() => expect(screen.getByText("Reopen Telegram to edit settings")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Relaunch and keep this panel" })).toBeNull();
  });

  it("renders the group settings command as inline code", async () => {
    const groupState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "not-private" },
    };

    renderMiniApp({ state: groupState });

    await waitFor(() => expect(screen.getByText("Group settings are command-only for now")).toBeTruthy());
    expect(screen.getByText("/settings@PharosWatchBot").tagName).toBe("CODE");
  });

  it("posts mutations and replaces returned state", async () => {
    const nextState = { ...baseState, subscriber: { ...baseState.subscriber, globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } } };
    const { catalog: _catalog, ...mutableNextState } = nextState;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => createTelegramMiniAppSnapshot(mutableNextState as TelegramMiniAppMutableState),
      });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-global", alertType: "safety", enabled: true } }),
    }));
    expect(screen.getByRole("button", { name: /Safety/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("never replays a mutation after a catalog-version mismatch", async () => {
    const nextVersions = { contractVersion: "3", catalogVersion: "catalog-v2-next" };
    refreshMiniAppBundleOnce(nextVersions, { storage: window.sessionStorage, refresh: vi.fn() });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: "Telegram Mini App catalog version changed",
          code: "catalog-version-mismatch",
          ...nextVersions,
        }),
      });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(screen.getByText("Mini App was updated. Close and reopen it from PharosWatchBot.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /Safety/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps confirmed global toggles unchanged after a generic mutation failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "x", code: "internal" }) });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    const safetyToggle = screen.getByRole("button", { name: /Safety/i });
    expect(safetyToggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(safetyToggle);

    await waitFor(() => expect(screen.getByText("Something went wrong. Try again or reopen Telegram.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /Safety/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps server-confirmed values visible while a mutation response is pending", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn() } } };
    const nextState: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true },
      },
    };
    let resolveMutation: ((response: { ok: true; json: () => Promise<TelegramMiniAppState> }) => void) | undefined;
    const mutationResponse = new Promise<{ ok: true; json: () => Promise<TelegramMiniAppState> }>((resolve) => {
      resolveMutation = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockReturnValueOnce(mutationResponse);
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    const safetyToggle = screen.getByRole("button", { name: /Safety/i });
    fireEvent.click(safetyToggle);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(safetyToggle.getAttribute("aria-pressed")).toBe("false");
    expect(safetyToggle.getAttribute("aria-busy")).toBe("true");
    expect(safetyToggle).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Launch/i })).toHaveProperty("disabled", true);

    resolveMutation?.({ ok: true, json: async () => nextState });
    await waitFor(() => expect(screen.getByRole("button", { name: /Safety/i }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: /Safety/i }).hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps last-known state visible and read-only after refresh failure until retry succeeds", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_725_000_000_000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "offline", code: "internal" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
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

  it("disables mutation controls for the server retry window and announces the countdown", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "3" }),
        json: async () => ({ error: "limit", code: "rate-limited", retryAfterSec: 3 }),
      });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Safety/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const countdown = screen.getByRole("timer");
    expect(countdown.getAttribute("aria-live")).toBe("off");
    expect(countdown.textContent).toContain("Settings unlock in 3 seconds");
    expect(screen.getByText("Pharos edit limit reached. Settings are disabled for 3 seconds.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Safety/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Launch/i })).toHaveProperty("disabled", true);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByRole("timer").textContent).toContain("Settings unlock in 1 second");
    expect(screen.getByRole("button", { name: /Safety/i })).toHaveProperty("disabled", true);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText(/Settings unlock in/)).toBeNull();
    expect(screen.getByText("Pharos editing is available again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Safety/i })).toHaveProperty("disabled", false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reloads session state after a stale-auth mutation rejection", async () => {
    const staleState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "Telegram Mini App session expired", code: "stale-auth" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => staleState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([path]) => new URL(String(path), "https://pharos.watch").pathname)).toEqual([
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

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Set global depeg step to 500 bps" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-global-depeg-step", depegStepBps: 500 } }),
    }));
    expect(screen.getByText("500 bps")).toBeTruthy();
  });

  it("dispatches chat-level snooze for 4h", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Snooze alerts for 4h" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-snooze", durationToken: "4h" } }),
    }));
  });

  it("dispatches a durable pause", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pause all alerts indefinitely" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "pause" } }),
    }));
  });

  it("renders a paused chat distinctly and offers Resume", async () => {
    const pausedState: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, exists: true, snoozeUntilTs: 4102444800 },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => pausedState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.getByText("Paused indefinitely")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resume alerts/i })).toBeTruthy();
  });

  it("explains launch-only subscriptions without showing tune controls", async () => {
    const launchOnlyState: TelegramMiniAppState = {
      ...baseState,
      subscriptions: [
        {
          ...baseState.subscriptions[0],
          alertTypes: { dews: false, depeg: false, safety: false, launch: true, reserve: false, freeze: false },
          depegStepBps: null,
        },
      ],
    };

    renderMiniApp({ state: launchOnlyState });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));

    expect(screen.getByText("Launch: on/off only. No tuning.")).toBeTruthy();
    expect(screen.queryByText("Tune USDC")).toBeNull();
  });

  it("orders exact search matches first and announces truncated results", async () => {
    const searchState: TelegramMiniAppState = {
      ...baseState,
      catalog: {
        ...baseState.catalog,
        searchableCoins: [
          { stablecoinId: "prefix-1", symbol: "USDT1", name: "USDT One", peg: "USD" },
          { stablecoinId: "prefix-2", symbol: "USDT2", name: "USDT Two", peg: "USD" },
          { stablecoinId: "prefix-3", symbol: "USDT3", name: "USDT Three", peg: "USD" },
          { stablecoinId: "prefix-4", symbol: "USDT4", name: "USDT Four", peg: "USD" },
          { stablecoinId: "prefix-5", symbol: "USDT5", name: "USDT Five", peg: "USD" },
          { stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether", peg: "USD" },
          { stablecoinId: "prefix-6", symbol: "USDT6", name: "USDT Six", peg: "USD" },
          { stablecoinId: "prefix-7", symbol: "USDT7", name: "USDT Seven", peg: "USD" },
          { stablecoinId: "prefix-8", symbol: "USDT8", name: "USDT Eight", peg: "USD" },
        ],
      },
    };

    renderMiniApp({ state: searchState });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.change(screen.getByLabelText("Search stablecoins"), { target: { value: "USDT" } });

    expect(screen.getByText("Showing first 8 of 9")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Follow / })[0]?.getAttribute("aria-label")).toBe("Follow USDT");
  });

  it("keeps suggested coins useful for followed and read-only accounts", async () => {
    const readOnlyState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
      catalog: {
        ...baseState.catalog,
        searchableCoins: [
          ...baseState.catalog.searchableCoins,
          { stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin", peg: "USD" },
        ],
      },
    };
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      renderMiniApp({ state: readOnlyState });
      await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
      fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));

      const followedSuggestion = screen.getByRole("button", { name: "Go to followed USDC" });
      const searchSuggestion = screen.getByRole("button", { name: "Search for USDT" });
      expect(followedSuggestion).toHaveProperty("disabled", false);
      expect(searchSuggestion).toHaveProperty("disabled", false);

      fireEvent.click(followedSuggestion);
      const coinRow = document.getElementById("coin-row-usdc-circle");
      await waitFor(() => expect(document.activeElement).toBe(coinRow));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });

      fireEvent.click(searchSuggestion);
      const searchInput = screen.getByLabelText("Search stablecoins");
      expect((searchInput as HTMLInputElement).value).toBe("USDT");
      await waitFor(() => expect(document.activeElement).toBe(searchInput));
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("clears per-coin snooze with the right durationToken", async () => {
    const coinSnoozed: TelegramMiniAppState = {
      ...baseState,
      subscriptions: [
        { ...baseState.subscriptions[0], snoozeUntilTs: 9_000_000_000 },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => coinSnoozed })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear USDC snooze" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "clear" } }),
    }));
  });

  it("dispatches set-timezone from the settings picker", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Europe/Paris" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-timezone", timezone: "Europe/Paris" } }),
    }));
  });

  it("configures a timezone-gated personalized daily recap", async () => {
    const enabledState: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        recap: {
          ...baseState.subscriber.recap,
          enabled: true,
          deliveryHourLocal: 9,
          nextDueAt: 1_720_018_800,
          lastOutcome: "skipped_no_changes",
        },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => enabledState })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...enabledState,
          subscriber: {
            ...enabledState.subscriber,
            recap: { ...enabledState.subscriber.recap, deliveryHourLocal: 14 },
          },
        }),
      });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("switch", { name: "Daily recap" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-recap", enabled: true, deliveryHourLocal: 9 } }),
    }));

    fireEvent.change(screen.getByLabelText("Delivery hour"), { target: { value: "14" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "set-recap", enabled: true, deliveryHourLocal: 14 } }),
    }));
    expect(screen.getByText("No material changes")).toBeTruthy();
  });

  it("hides recap controls when the server rollout does not expose them", async () => {
    const state: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        recap: { ...baseState.subscriber.recap, available: false },
      },
    };

    renderMiniApp({ state });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));

    expect(screen.queryByRole("switch", { name: "Daily recap" })).toBeNull();
  });

  it("requires an explicitly confirmed timezone before enabling a recap", async () => {
    const state: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { ...baseState.subscriber.quietHours, timezone: null },
        recap: { ...baseState.subscriber.recap, timezoneConfirmed: false },
      },
    };

    renderMiniApp({ state });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));

    expect(screen.getByRole("switch", { name: "Daily recap" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Confirm a timezone below before enabling your recap.")).toBeTruthy();
  });

  it("offers a compact timezone picker plus searchable full coverage and confirmed recent zones", async () => {
    const honoluluState: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { ...baseState.subscriber.quietHours, timezone: "Pacific/Honolulu" },
      },
    };
    const parisState: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { ...baseState.subscriber.quietHours, timezone: "Europe/Paris" },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => honoluluState })
      .mockResolvedValueOnce({ ok: true, json: async () => parisState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));

    const compactPicker = screen.getByLabelText("Timezone") as unknown as HTMLSelectElement;
    const fullPicker = screen.getByLabelText("Timezone name") as HTMLInputElement;
    const datalist = document.getElementById("telegram-mini-app-timezone-options");
    expect(compactPicker.options.length).toBeLessThan(20);
    expect(datalist?.querySelectorAll("option").length).toBeGreaterThan(compactPicker.options.length);

    fireEvent.change(fullPicker, { target: { value: "Pacific/Honolulu" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply timezone" }));
    await waitFor(() => expect(compactPicker.value).toBe("Pacific/Honolulu"));

    fireEvent.change(compactPicker, { target: { value: "Europe/Paris" } });
    await waitFor(() => expect(compactPicker.value).toBe("Europe/Paris"));
    expect(Array.from(compactPicker.options).some((option) => option.text === "Recent: Pacific/Honolulu")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("renders quiet hours in the configured timezone", async () => {
    const state: TelegramMiniAppState = {
      ...baseState,
      subscriber: {
        ...baseState.subscriber,
        quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7, timezone: "Europe/Paris" },
      },
    };

    renderMiniApp({ state });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));

    expect(screen.getAllByText("Quiet hours: 22:00–07:00 Europe/Paris").length).toBeGreaterThan(0);
    expect(screen.queryByText(/doesn.t track your timezone/i)).toBeNull();
  });

  it("confirms unsubscribe-all once before dispatching", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(true));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { showConfirm } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(showConfirm.mock.calls[0]?.[0]).toMatch(/clears every coin, preset, and global toggle/i);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "unsubscribe-all" } }),
    }));
  });

  it("arms unsubscribe-all into an explicit Confirm/Cancel row when showConfirm is absent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));
    expect(screen.getByRole("button", { name: "Confirm unsubscribe from all alerts" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Unsubscribe from all" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from all" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unsubscribe from all alerts" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "unsubscribe-all" } }),
    }));
  });

  it("warns that unfollowing a preset also removes covered coin rows", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(false));
    const state: TelegramMiniAppState = {
      ...baseState,
      presets: [{ id: "usd-top25", label: "USD Top 25", alertTypes: { dews: true, depeg: true, safety: false }, depegStepBps: 250 }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => state });

    renderMiniApp({ fetchImpl: fetchMock, launch: { showConfirm } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "presets" }));
    fireEvent.click(screen.getByRole("button", { name: "Unfollow USD Top 25" }));

    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(showConfirm.mock.calls[0]?.[0]).toMatch(/direct coin settings and overlapping presets will stay unchanged/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires two-step confirmation for forget-me and shows the terminal screen", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(true));
    const close = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { showConfirm, close } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "forget-me" } }),
    }));
    await waitFor(() => expect(screen.getByText("Your data has been deleted")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close Mini App" }));
    expect(close).toHaveBeenCalled();
  });

  it("uses Telegram confirmation before removing a coin and honors cancel", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(false));
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { showConfirm } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove USDC" }));

    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("confirmed remove shows undo toast and dispatches set-coin on undo click", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(true));
    const stateAfterRemove: TelegramMiniAppState = { ...baseState, subscriptions: [] };
    const stateAfterUndo: TelegramMiniAppState = { ...baseState };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => stateAfterRemove })
      .mockResolvedValueOnce({ ok: true, json: async () => stateAfterUndo });

    renderMiniApp({ fetchImpl: fetchMock, launch: { showConfirm } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove USDC" }));

    // Undo toast appears after successful remove.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo remove USDC" })).toBeTruthy());

    // Clicking Undo dispatches set-coin restoring the removed coin.
    fireEvent.click(screen.getByRole("button", { name: "Undo remove USDC" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const undoBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
    expect(undoBody.operation.kind).toBe("set-coin");
    expect(undoBody.operation.stablecoinId).toBe("usdc-circle");
  });

  it("undo toast auto-dismisses after 5 seconds", async () => {
    const showConfirm = vi.fn((_msg: string, cb: (ok: boolean) => void) => cb(true));
    const stateAfterRemove: TelegramMiniAppState = { ...baseState, subscriptions: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => stateAfterRemove });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderMiniApp({ fetchImpl: fetchMock, launch: { showConfirm } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove USDC" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Undo remove USDC" })).toBeTruthy());

    // Advance past the 5s UNDO_WINDOW_MS — toast disappears.
    await act(async () => {
      vi.advanceTimersByTime(5001);
    });
    expect(screen.queryByRole("button", { name: "Undo remove USDC" })).toBeNull();
  });

  it("requestWriteAccess fires once after recommended-setup for sender chat with no prior subscriber", async () => {
    const requestWriteAccess = vi.fn();
    const isVersionAtLeast = vi.fn((v: string) => v === "6.9" || v === "8.0");
    const initialState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, chatType: "sender" },
      subscriber: { ...baseState.subscriber, exists: false },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { isVersionAtLeast, requestWriteAccess } });
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
    const initialState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, chatType: "private" },
      subscriber: { ...baseState.subscriber, exists: false },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { isVersionAtLeast, requestWriteAccess } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestWriteAccess).not.toHaveBeenCalled();
  });

  it("probes checkHomeScreenStatus only after first mutation and renders the CTA when missed", async () => {
    const checkHomeScreenStatus = vi.fn((cb: (s: string) => void) => cb("missed"));
    const isVersionAtLeast = vi.fn((v: string) => v === "8.0");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { isVersionAtLeast, checkHomeScreenStatus } });
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { isVersionAtLeast, checkHomeScreenStatus } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Use recommended setup/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checkHomeScreenStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /Add to home screen/i })).toBeNull();
  });

  it("opens in-app Why / Coverage views and keeps bot reply fallbacks", async () => {
    const openTelegramLink = vi.fn();
    const openLink = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { openTelegramLink, openLink } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "watchlist" }));
    fireEvent.click(screen.getByRole("button", { name: "Why USDC" }));
    expect(screen.getByText("Why USDC")).toBeTruthy();
    expect(openTelegramLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open bot reply" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=why_usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: "Close Why USDC" }));

    fireEvent.click(screen.getByRole("button", { name: "Coverage USDC" }));
    expect(screen.getByText("Coverage USDC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open bot reply" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=coverage_usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: "Close Coverage USDC" }));

    fireEvent.click(screen.getByRole("button", { name: "View USDC on Pharos" }));
    expect(openLink).toHaveBeenCalledWith("https://pharos.watch/stablecoin/usdc-circle");
  });

  it.each([
    [401, "stale-auth", "Telegram authorization expired. Close and reopen from PharosWatchBot."],
    [403, "not-private", "This Mini App can only edit personal alerts. Use the bot commands in groups."],
    [400, "validation-error", "Change was rejected by the server."],
    [400, "unknown-coin", "Change was rejected by the server."],
    [400, "invalid-timezone", "Change was rejected by the server."],
    [413, "body-too-large", "Request was too large to send."],
    [503, "preset-unavailable", "Mini App backend is temporarily unavailable. Try again shortly."],
    [503, "not-configured", "Mini App backend is temporarily unavailable. Try again shortly."],
    [500, "internal", "Something went wrong. Try again or reopen Telegram."],
  ] as const)("maps mutation status %i / code %s to copy", async (status, code, expected) => {
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

    renderMiniApp({ fetchImpl: fetchMock });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Safety/i }));

    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
  });

  it("renders the sample-alert CTA and deep-links into the bot DM when openTelegramLink is present", async () => {
    const openTelegramLink = vi.fn();
    const impactOccurred = vi.fn();

    renderMiniApp({ launch: { HapticFeedback: { impactOccurred }, openTelegramLink } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());

    const sampleButton = screen.getByRole("button", { name: "Send me a sample alert" });
    fireEvent.click(sampleButton);
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=sample");
    expect(impactOccurred).toHaveBeenCalledWith("light");
  });

  it("hides the sample-alert CTA when openTelegramLink is unavailable", async () => {
    renderMiniApp();
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Send me a sample alert" })).toBeNull();
  });

  it("arms forget-me into an explicit Confirm/Cancel row when showConfirm is absent", async () => {
    // No showConfirm on the bridge → in-page Arm → Confirm/Cancel fallback.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => baseState })
      .mockResolvedValueOnce({ ok: true, json: async () => baseState });

    renderMiniApp({ fetchImpl: fetchMock, launch: { close: vi.fn() } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "settings" }));

    // First tap arms: reveals Confirm + Cancel, does NOT delete.
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));
    expect(screen.getByRole("button", { name: "Confirm delete all my data forever" })).toBeTruthy();
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cancel returns to idle without firing onForgetMe.
    fireEvent.click(cancelButton);
    expect(screen.getByRole("button", { name: "Delete all my data" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Re-arm then Confirm fires the forget-me mutation.
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete all my data forever" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ initData: "signed-init-data", operation: { kind: "forget-me" } }),
    }));
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

    renderMiniApp({ fetchImpl: fetchMock, launch: { MainButton: mainButton } });
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

  it("hides the native MainButton for read-only sessions", async () => {
    const mainButton = {
      show: vi.fn(),
      hide: vi.fn(),
      setParams: vi.fn(),
      onClick: vi.fn(),
      offClick: vi.fn(),
    };
    const readOnlyState: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" },
      subscriber: { ...baseState.subscriber, exists: false, snoozeUntilTs: null },
    };

    renderMiniApp({ state: readOnlyState, launch: { MainButton: mainButton } });
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());

    expect(mainButton.onClick).not.toHaveBeenCalled();
    expect(mainButton.show).not.toHaveBeenCalled();
    expect(mainButton.hide).toHaveBeenCalled();
  });

  it("guards duplicate native MainButton clicks while the mutation is in flight", async () => {
    const onClickHandlers: Array<() => void> = [];
    const mainButton = {
      show: vi.fn(),
      hide: vi.fn(),
      setParams: vi.fn(),
      onClick: vi.fn((handler: () => void) => { onClickHandlers.push(handler); }),
      offClick: vi.fn(),
    };
    const noSubscriberState: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, exists: false, snoozeUntilTs: null },
    };
    let resolveMutation!: (value: { ok: true; json: () => Promise<TelegramMiniAppState> }) => void;
    const mutationResponse = new Promise<{ ok: true; json: () => Promise<TelegramMiniAppState> }>((resolve) => {
      resolveMutation = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => noSubscriberState })
      .mockReturnValueOnce(mutationResponse);
    installMiniAppFetch(fetchMock);
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { notificationOccurred: vi.fn(), impactOccurred: vi.fn() }, MainButton: mainButton } };

    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("@watcher")).toBeTruthy());
    await waitFor(() => expect(onClickHandlers.length).toBe(1));

    act(() => {
      onClickHandlers[0]?.();
      onClickHandlers[0]?.();
    });

    await waitFor(() => {
      if (fetchMock.mock.calls.length !== 2) throw new Error("mutation fetch has not started");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveMutation({ ok: true, json: async () => baseState });
    await waitFor(() => expect(screen.getByText("Recommended setup applied.")).toBeTruthy());
  });

});
