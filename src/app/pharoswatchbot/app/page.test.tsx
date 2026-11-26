// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
} from "@shared/lib/telegram-mini-app-contract";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { isMiniAppErrorCode, miniAppErrorMessage, MiniAppRequestError } from "./error-messages";
import PharosWatchBotMiniAppPage, { metadata } from "./page";
import { baseState, makeMiniAppState } from "@shared/test-utils/telegram-mini-app-state";
import type { TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { installMatchMediaMock } from "@/test-utils/frontend";
import { PharosWatchBotMiniAppClient } from "./client";

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
  await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeTruthy());
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

function nativeButton() {
  const callbacks: Array<() => void> = [];
  const live = new Set<() => void>();
  let visible = false;
  let active = true;
  let text: string | undefined;
  return {
    callbacks,
    live,
    get isVisible() { return visible; },
    get isActive() { return visible && active; },
    get text() { return visible ? text : undefined; },
    show: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    onClick: vi.fn((callback: () => void) => { callbacks.push(callback); live.add(callback); }),
    offClick: vi.fn((callback: () => void) => { live.delete(callback); }),
    setParams: vi.fn((params: { text?: string; is_visible?: boolean; is_active?: boolean }) => {
      if (params.text != null) text = params.text;
      if (params.is_visible != null) visible = params.is_visible;
      if (params.is_active != null) active = params.is_active;
    }),
    showProgress: vi.fn(),
    hideProgress: vi.fn(),
    /** Click whatever handler is currently attached. */
    click() { for (const callback of [...live]) callback(); },
  };
}

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const preview = (adds: string[], removes: string[] = []) => ok({
  contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
  catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
  result: {
    kind: "bulk-watchlist-preview",
    expectedPreferenceGeneration: 1,
    previewFingerprint: "preview-v1-12-deadbeef",
    adds,
    removes,
    unchanged: [],
    sourceImpact: [],
    undo: { expectedPreferenceGeneration: 2, expectedFingerprint: "preview-v1-12-deadbeef", restoreDirectRows: [], removeStablecoinIds: adds },
  },
});
const staleAuthState: TelegramMiniAppState = { ...baseState, viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" } };
const newUserState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, exists: false, snoozeUntilTs: null } };
const top25 = (alertTypes: Partial<TelegramMiniAppState["presets"][number]["alertTypes"]>, memberIds: string[] | null) => ({
  id: "usd-top25" as const,
  label: "USD Top 25",
  alertTypes: { dews: false, depeg: false, safety: false, ...alertTypes },
  depegStepBps: null,
  memberIds,
});
const rankedCatalog: TelegramMiniAppState["catalog"] = {
  recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }, { id: "usd-top50", label: "USD Top 50" }],
  searchableCoins: [
    { stablecoinId: "usd0-usual", symbol: "USD0", name: "Usual USD", peg: "USD", rank: 70 },
    { stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin", peg: "USD", rank: 6 },
    { stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether", peg: "USD", rank: 1 },
  ],
};

/** Switch names are "<label>: <subtitle>"; match the label part only. */
function switchName(label: string): (accessibleName: string) => boolean {
  return (accessibleName) => accessibleName === label || accessibleName.startsWith(`${label}:`);
}

function hideFor(ms: number): void {
  const now = Date.now();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.spyOn(Date, "now").mockReturnValue(now + ms);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
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
  it("makes forget-me terminal for retained native Back, Settings, and Main callbacks", async () => {
    const back = nativeButton();
    const settings = nativeButton();
    const main = nativeButton();
    const confirmations: Array<(confirmed: boolean) => void> = [];
    const close = vi.fn();
    const state = { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs: PAUSE_SENTINEL_TS } };
    const fetchMock = await renderReadyMiniApp({
      state,
      launch: {
        BackButton: back, SettingsButton: settings, MainButton: main, close,
        showConfirm: vi.fn((_message, callback) => { confirmations.push(callback); }),
      },
    });
    await waitFor(() => expect(main.text).toBe("Resume alerts"));
    const retainedResume = main.callbacks.at(-1)!;
    act(() => settings.click());
    await waitFor(() => expect(back.isVisible).toBe(true));
    const retainedBack = back.callbacks.at(-1)!;
    const retainedSettings = settings.callbacks.at(-1)!;
    fireEvent.click(screen.getByRole("button", { name: /^Delete all my data/ }));
    act(() => { confirmations.shift()?.(true); });
    act(() => { confirmations.shift()?.(true); });
    await waitFor(() => expect(screen.getByText("Your data has been deleted")).toBeTruthy());
    expect(document.querySelector(".pharos-mini-app")).toBeTruthy();
    expectMutationRequest(fetchMock, { kind: "forget-me" });
    const callsAfterDeletion = fetchMock.mock.calls.length;
    act(() => { retainedBack(); retainedSettings(); retainedResume(); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterDeletion);
    expect(back.isVisible).toBe(false);
    expect(settings.isVisible).toBe(false);
    expect(main.isVisible).toBe(false);
    expect(back.offClick).toHaveBeenCalledWith(retainedBack);
    expect(settings.offClick).toHaveBeenCalledWith(retainedSettings);
    expect(main.offClick).toHaveBeenCalledWith(retainedResume);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps metadata and the Mini App error-code contract", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(isMiniAppErrorCode("empty-alert-types")).toBe(false);
    expect(isMiniAppErrorCode("stale_auth")).toBe(false);
    expect(isMiniAppErrorCode(null)).toBe(false);
    expect(isMiniAppErrorCode("stale-recap-preference")).toBe(false);
    for (const [err, ctx, expected] of [
      [new MiniAppRequestError(429, "rate-limited", 12), "mutation", "Too many changes in a row. Wait a few seconds, then try again."],
      [new MiniAppRequestError(429, "rate-limited", 3), "session", "Still opening. Wait 3 seconds, then try again."],
      [new MiniAppRequestError(400, "invalid-alert-types"), "mutation", "Keep at least one alert on for this preset."],
      [new MiniAppRequestError(400, "invalid-timezone"), "mutation", "That time zone isn't recognized. Pick another from the list."],
      [new MiniAppRequestError(400, "unknown-coin"), "mutation", "That coin isn't available for alerts. Nothing was saved."],
      [new MiniAppRequestError(400, "unknown-preset"), "mutation", "That preset isn't available right now. Nothing was saved."],
      [new MiniAppRequestError(500, "internal"), "mutation", "Couldn't confirm this change."],
      [new TypeError("Failed to fetch"), "mutation", "Couldn't confirm this change."],
    ] as const) {
      expect(miniAppErrorMessage(err, ctx)).toBe(expected);
    }
  });

  it("renders browser preview immediately without calling session APIs and allowlists startapp pass-through", () => {
    window.history.replaceState({}, "", "/pharoswatchbot/app/?startapp=coin_usdc-circle");
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open PharosWatchBot/ }).getAttribute("href"))
      .toBe("https://t.me/PharosWatchBot?startapp=coin_usdc-circle");
    expect(fetchMock).not.toHaveBeenCalled();

    cleanup();
    window.history.replaceState({}, "", "/pharoswatchbot/app/?startapp=../evil");
    render(<PharosWatchBotMiniAppPage />);
    expect(screen.getByRole("link", { name: /Open PharosWatchBot/ }).getAttribute("href"))
      .toBe("https://t.me/PharosWatchBot?startapp=home");
  });

  it("starts hash-based session fetch immediately in parallel with late SDK binding and emits preconnect links", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop");
    const fetchMock = vi.fn().mockResolvedValue(ok(baseState));
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    expect(document.querySelector('link[rel="preconnect"][href="https://api.pharos.watch"]')).toBeTruthy();
    expect(document.querySelector('link[rel="preconnect"][href="https://telegram.org"]')).toBeTruthy();
    expect(document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')).toBeTruthy();
    // Signed URL launch data starts POST /session at t=0 without waiting on telegram-web-app.js.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledOnce();
    const sessionUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://pharos.watch");
    expect(sessionUrl.pathname).toBe("/api/telegram-mini-app/session");
    expect(sessionUrl.searchParams.get(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM)).toBe(TELEGRAM_MINI_APP_CONTRACT_VERSION);
    expect(sessionUrl.searchParams.get(TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM)).toBe(TELEGRAM_MINI_APP_CATALOG_VERSION);
    expect(screen.getByRole("heading", { name: "Alerts on" })).toBeTruthy();

    // Late-arriving SDK still binds ready() and native buttons without a second session fetch.
    const ready = vi.fn();
    const settings = nativeButton();
    window.Telegram = { WebApp: { initData: "signed-init-data", platform: "tdesktop", initDataUnsafe: { user: { username: "watcher" } }, ready, SettingsButton: settings } };
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(ready).toHaveBeenCalledOnce();
    expect(settings.isVisible).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats browser-created and unsupported-host SDK objects as preview", () => {
    vi.useFakeTimers();
    window.Telegram = { WebApp: { initData: "", platform: "unknown", ready: vi.fn() } };
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();

    cleanup();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=unknown");
    window.Telegram = { WebApp: { initData: "signed-init-data", platform: "unknown", ready: vi.fn() } };
    render(<PharosWatchBotMiniAppPage />);
    expect(screen.getByText("PharosWatchBot app preview")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the signed URL launch payload when the Telegram SDK never loads", async () => {
    vi.useFakeTimers();
    const signed = "auth_date=1800000000&hash=abc&user=%7B%7D";
    window.history.replaceState({}, "", `/pharoswatchbot/app/#tgWebAppData=${encodeURIComponent(signed)}&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop`);
    const fetchMock = vi.fn().mockResolvedValue(ok(baseState));
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_050); });

    expect(screen.getByRole("heading", { name: "Alerts on" })).toBeTruthy();
    expect(screen.queryByText("Telegram didn't pass your launch details. Close and reopen from PharosWatchBot.")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ initData: signed });
  });

  it("loads the session into the tab-free Home screen", async () => {
    const ready = vi.fn();
    const expand = vi.fn();
    const state = makeMiniAppState({ presets: [top25({ dews: true, depeg: true }, ["usdc-circle"])] });
    await renderReadyMiniApp({ state, launch: { ready, expand } });
    expect(ready).toHaveBeenCalled();
    expect(expand).toHaveBeenCalled();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Refresh session" })).toBeNull();
    for (const section of ["Presets", "Your coins"]) expect(screen.getByRole("heading", { name: section })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Make it quieter" })).toBeNull();
    expect(screen.queryByText(/Pharos stores your Telegram user ID/)).toBeNull();
    expect(screen.getByRole("button", { name: /^USD Top 25/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^All stablecoins/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "USDC, USD Coin, DEWS · Depeg" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Pause alerts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("shows plain session errors and retries a failed load", async () => {
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    installMiniAppFetch(vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "Invalid" }) }));
    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("Telegram couldn't confirm this window. Close and reopen it from PharosWatchBot.")).toBeTruthy());

    cleanup();
    const main = nativeButton();
    window.Telegram = { WebApp: { initData: "signed-init-data", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn(), MainButton: main } };
    const retryFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "Unavailable" }) })
      .mockResolvedValueOnce(ok(baseState));
    installMiniAppFetch(retryFetch);
    render(<PharosWatchBotMiniAppPage />);
    await waitFor(() => expect(screen.getByText("Couldn't load your alerts. Try again.")).toBeTruthy());
    // The MainButton owns the retry, so no competing inline Close or Retry.
    await waitFor(() => expect(main.text).toBe("Try again"));
    expect(screen.queryByRole("button", { name: "Close and reopen" })).toBeNull();
    act(() => main.click());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alerts on" })).toBeTruthy());
    expect(retryFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, "Alerts on"],
    ["watchlist", "Alerts on"],
    ["presets", "Follow a preset"],
    ["settings", "Settings"],
    ["snooze", "Settings"],
    ["coin_usdc-circle", "USDC"],
    ["why_usdc-circle", "USDC"],
    ["coverage_usdc-circle", "USDC"],
  ] as const)("boots start_param %s on its screen", async (startParam, heading) => {
    const fetchMock = await renderReadyMiniApp(startParam == null ? {} : { launch: { initDataUnsafe: { start_param: startParam } } });
    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows the setup screen to new users and opens coin selection from startapp=setup for everyone", async () => {
    const main = nativeButton();
    await renderReadyMiniApp({ state: newUserState, launch: { MainButton: main } });
    expect(screen.getByRole("heading", { name: "Get stablecoin alerts in this chat" })).toBeTruthy();
    expect(screen.getByText(/Pharos stores your Telegram user ID/)).toBeTruthy();
    await waitFor(() => expect(main.text).toBe("Follow USD Top 25"));
    // One primary action, never mirrored inline.
    expect(screen.queryByRole("button", { name: "Follow USD Top 25" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send a sample alert/ })).toBeNull();

    for (const state of [newUserState, baseState]) {
      cleanup();
      const back = nativeButton();
      await renderReadyMiniApp({ state, launch: { BackButton: back, initDataUnsafe: { start_param: "setup" } } });
      expect(await screen.findByLabelText("Search stablecoins")).toBeTruthy();
      await waitFor(() => expect(back.isVisible).toBe(true));
    }
  });

  it("hides every edit control and SettingsButton for a read-only group chat", async () => {
    const main = nativeButton();
    const settings = nativeButton();
    const openTelegramLink = vi.fn();
    const state = makeMiniAppState({ viewer: { chatId: null, chatType: "supergroup", canMutate: false, mutationBlockReason: "not-private" }, subscriber: { exists: false } });
    await renderReadyMiniApp({ state, launch: { MainButton: main, SettingsButton: settings, openTelegramLink } });
    expect(screen.getByRole("heading", { name: "Group alerts are managed in the group" })).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add coins" })).toBeNull();
    expect(main.isVisible).toBe(false);
    expect(settings.isVisible).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Open your personal alerts/ }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?startapp=home");
  });

  it("explains coin coverage: on, via a preset, off override, unknown membership, and legacy safety recovery", async () => {
    const coin = {
      ...baseState.subscriptions[0]!,
      alertTypes: { ...baseState.subscriptions[0]!.alertTypes, depeg: false, safety: true },
      alertOverrides: { dews: false, depeg: true, safety: false, launch: false, reserve: false, freeze: false },
      safetyMode: "upgrade-only" as const,
    };
    const state = makeMiniAppState({
      subscriber: { globalAlerts: { dews: false, depeg: false } },
      subscriptions: [coin],
      presets: [top25({ dews: true, depeg: true, safety: true }, ["usdc-circle"])],
      catalog: rankedCatalog,
    });
    const openLink = vi.fn();
    const openTelegramLink = vi.fn();
    const fetchMock = await renderReadyMiniApp({ state, launch: { initDataUnsafe: { start_param: "coin_usdc-circle" }, openLink, openTelegramLink } });
    const sw = (name: string) => screen.getByRole("switch", { name: switchName(`USDC ${name}`) });
    expect(sw("Early warning (DEWS)").getAttribute("aria-checked")).toBe("true");
    expect(sw("Depeg").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Off for USDC. USD Top 25 would cover it.")).toBeTruthy();
    expect(sw("Safety Score").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByLabelText("Changes")).toBeNull();
    expect(screen.getByText("Live downgrade alerts are off")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Launch/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /View on Pharos/ }));
    expect(openLink).toHaveBeenCalledWith("https://pharos.watch/stablecoin/usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: /Send status to chat/ }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=status_usdc-circle");

    // Legacy upgrade-only recovery chip clears safetyMode to null.
    fireEvent.click(within(screen.getByRole("group", { name: "Turn on live downgrade alerts for USDC" })).getByRole("button"));
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { safetyMode: null } }));

    // Unreadable membership on a followed coin renders "—" with NO switch (R2).
    cleanup();
    const withoutSafety = { ...coin, alertTypes: { ...coin.alertTypes, safety: false }, safetyMode: null };
    await renderReadyMiniApp({
      state: { ...state, subscriptions: [withoutSafety], presets: [top25({ safety: true }, null)] },
      launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } },
    });
    expect(screen.queryByRole("switch", { name: switchName("USDC Safety Score") })).toBeNull();
    const unknownRow = screen.getByText("Can't check USD Top 25 coverage right now").closest<HTMLElement>("div.relative")!;
    expect(within(unknownRow).getByText("—")).toBeTruthy();
  });

  it("claims neither coverage nor a mute when a followed preset's members are unreadable", async () => {
    const state = makeMiniAppState({ subscriber: { globalAlerts: { dews: false, depeg: false, safety: false } }, presets: [top25({ dews: true, safety: true }, null)], catalog: rankedCatalog });
    await renderReadyMiniApp({ state, launch: { initDataUnsafe: { start_param: "coin_usdt-tether" } } });
    const row = screen.getAllByText("Can't check USD Top 25 coverage right now")[0]!.closest<HTMLElement>("div.relative")!;
    expect(within(row).getByText("—")).toBeTruthy();
    expect(within(row).queryByText("Off")).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);

    cleanup();
    await renderReadyMiniApp({ state: makeMiniAppState({ presets: [top25({ safety: true }, null)], catalog: rankedCatalog }), launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });
    expect(screen.queryByRole("switch", { name: switchName("USDC Safety Score") })).toBeNull();
    expect(within(screen.getByText("Can't check USD Top 25 coverage right now").closest<HTMLElement>("div.relative")!).getByText("—")).toBeTruthy();
  });

  it("customizes covered coins, follows uncovered coins, and offers Browse coins for removed coins", async () => {
    const main = nativeButton();
    const fetchMock = await renderReadyMiniApp({ state: makeMiniAppState({ catalog: rankedCatalog }), launch: { MainButton: main, initDataUnsafe: { start_param: "coin_usdt-tether" } } });
    // Read-only switches until customized, but Snooze stays enabled for covered coins.
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Snooze USDT" })).toBeTruthy();
    expect(screen.getByText("Customize USDT to turn alerts off or tune thresholds.")).toBeTruthy();
    expect(screen.getAllByText("On")).toHaveLength(2);
    expect(screen.getAllByText("Off")).toHaveLength(3);
    await waitFor(() => expect(main.text).toBe("Customize USDT"));
    act(() => main.click());
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-coin", stablecoinId: "usdt-tether", patch: { alertTypes: { dews: true, depeg: true } } }));

    cleanup();
    const uncoveredMain = nativeButton();
    await renderReadyMiniApp({
      state: makeMiniAppState({ subscriber: { globalAlerts: { dews: false, depeg: false } }, catalog: rankedCatalog }),
      launch: { MainButton: uncoveredMain, initDataUnsafe: { start_param: "coin_usdt-tether" } },
    });
    expect(screen.getByText("Not in your coins yet.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Snooze USDT" })).toBeNull();
    await waitFor(() => expect(uncoveredMain.text).toBe("Follow USDT"));

    cleanup();
    const unknownMain = nativeButton();
    const unknownFetch = await renderReadyMiniApp({ launch: { MainButton: unknownMain, initDataUnsafe: { start_param: "coin_old-coin" } } });
    expect(screen.getAllByText("Pharos no longer tracks this coin").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Browse coins" })).toBeTruthy();
    expect(unknownMain.isVisible).toBe(false);
    expect(unknownFetch).toHaveBeenCalledOnce();
  });

  it("adds coins through one ranked multi-select, the bulk preview/confirm pair, and a snackbar undo", async () => {
    const main = nativeButton();
    const back = nativeButton();
    const state = makeMiniAppState({ catalog: rankedCatalog });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(state))
      .mockResolvedValueOnce(preview(["usdt-tether", "usd0-usual"]))
      .mockResolvedValueOnce(ok(state))
      .mockResolvedValueOnce(ok(state));
    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { MainButton: main, BackButton: back } });
    fireEvent.click(screen.getByRole("button", { name: "Add coins" }));
    fireEvent.change(screen.getByLabelText("Search stablecoins"), { target: { value: "usd" } });
    const rows = () => screen.getAllByRole("checkbox").map((row) => [row.getAttribute("aria-label"), row.getAttribute("aria-checked")]);
    expect(rows()).toEqual([["USDT Tether", "false"], ["USDC USD Coin, following", "true"], ["USD0 Usual USD", "false"]]);
    expect(main.isVisible).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "USDT Tether" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "USD0 Usual USD" }));
    expect(rows()).toEqual([["USDT Tether, will be added", "true"], ["USDC USD Coin, following", "true"], ["USD0 Usual USD, will be added", "true"]]);
    expect(screen.getAllByText(/^Will be added/)).toHaveLength(2);
    // The MainButton count matches exactly the rows marked as changes.
    await waitFor(() => expect(main.text).toBe("Add 2 coins"));
    fireEvent.click(screen.getByRole("checkbox", { name: "USDC USD Coin, following" }));
    expect(screen.getByRole("checkbox", { name: "USDC USD Coin, will be removed" }).getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(main.text).toBe("Save 3 changes"));
    fireEvent.click(screen.getByRole("checkbox", { name: "USDC USD Coin, will be removed" }));
    await waitFor(() => expect(main.text).toBe("Add 2 coins"));

    act(() => main.click());
    await waitFor(() => expect(screen.getByText("Added 2 coins.")).toBeTruthy());
    const selection = { addStablecoinIds: ["usdt-tether", "usd0-usual"], removeStablecoinIds: [] };
    expectMutationRequest(fetchMock, { kind: "preview-bulk-watchlist", ...selection }, 2);
    expectMutationRequest(fetchMock, { kind: "confirm-bulk-watchlist", ...selection, expectedPreferenceGeneration: 1, previewFingerprint: "preview-v1-12-deadbeef" }, 3);
    expect(screen.getByRole("heading", { name: "Alerts on" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Undo" })).toHaveProperty("disabled", true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expectMutationRequest(fetchMock, { kind: "undo-bulk-watchlist", expectedPreferenceGeneration: 2, expectedFingerprint: "preview-v1-12-deadbeef", restoreDirectRows: [], removeStablecoinIds: ["usdt-tether", "usd0-usual"] });
  });

  it.each(["preview", "confirm"])("reconciles snackbar Undo with a draft and retains it after a failed %s", async (failure) => {
    const main = nativeButton();
    const state = makeMiniAppState({ catalog: rankedCatalog });
    const undo = {
      expectedPreferenceGeneration: 2, expectedFingerprint: "preview-v1-12-deadbeef",
      restoreDirectRows: [{
        stablecoinId: "usdc-circle", alertDews: true, alertDepeg: true, alertSafety: false, alertLaunch: false, alertReserve: false,
        overrideDews: false, overrideDepeg: false, overrideSafety: false, overrideLaunch: false, overrideReserve: false,
        dewsMinBand: "ALERT" as const, safetyMode: null, depegWorseningBpsStep: 250,
      }], removeStablecoinIds: [],
    };
    const fetchMock = mockStateResponses(state);
    fetchMock.mockResolvedValueOnce(ok({ contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION, catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      stateRevision: "removed", state: { ...state, subscriptions: [] }, undo })).mockResolvedValueOnce(ok(state));
    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { MainButton: main, initDataUnsafe: { start_param: "coin_usdc-circle" } } });
    fireEvent.click(screen.getByRole("button", { name: "Use All stablecoins settings for USDC" }));
    await screen.findByText("USDC reset to All stablecoins settings.");
    fireEvent.click(screen.getByRole("button", { name: "Add coins" }));
    const search = screen.getByLabelText("Search stablecoins");
    for (const [symbol, name] of [["USDC", /^USDC /], ["USD0", /^USD0 /]] as const) {
      fireEvent.change(search, { target: { value: symbol } });
      fireEvent.click(screen.getByRole("checkbox", { name }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.change(search, { target: { value: "usd" } });
    const ready = (label: string, calls?: number) => waitFor(() => {
      if (calls != null) expect(fetchMock).toHaveBeenCalledTimes(calls);
      expect([main.text, main.isActive, main.live.size]).toEqual([label, true, 1]);
    });
    await ready("Add 1 coin", 3);
    expect(screen.getByRole("checkbox", { name: "USDC USD Coin, following" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "USDC USD Coin, following" }));
    await ready("Save 2 changes");
    const selection = { addStablecoinIds: ["usd0-usual"], removeStablecoinIds: ["usdc-circle"] };
    if (failure === "confirm") fetchMock.mockResolvedValueOnce(preview(selection.addStablecoinIds, selection.removeStablecoinIds));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    act(() => main.click());
    await screen.findByText("Couldn't confirm this change.");
    const failedCalls = failure === "confirm" ? 5 : 4;
    await ready("Save 2 changes", failedCalls);
    expect(screen.getByRole("checkbox", { name: "USDC USD Coin, will be removed" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("checkbox", { name: "USD0 Usual USD, will be added" }).getAttribute("aria-checked")).toBe("true");
    fetchMock.mockResolvedValueOnce(preview(selection.addStablecoinIds, selection.removeStablecoinIds)).mockResolvedValueOnce(ok(state));
    act(() => main.click());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(failedCalls + 2);
      expectMutationRequest(fetchMock, { kind: "confirm-bulk-watchlist", ...selection, expectedPreferenceGeneration: 1, previewFingerprint: "preview-v1-12-deadbeef" }, failedCalls + 2);
    });
    await screen.findByText("Added 1 coin, removed 1.");
  });

  it("follows a preset from Follow a preset through the MainButton", async () => {
    const main = nativeButton();
    const fetchMock = await renderReadyMiniApp({ state: makeMiniAppState({ catalog: rankedCatalog }), launch: { MainButton: main } });
    fireEvent.click(screen.getByRole("button", { name: "Follow a preset" }));
    fireEvent.click(screen.getByRole("button", { name: /^USD Top 50/ }));
    await waitFor(() => expect(main.text).toBe("Follow USD Top 50"));
    fireEvent.click(screen.getByRole("switch", { name: switchName("USD Top 50 Safety Score") }));
    act(() => main.click());
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "follow-preset", presetId: "usd-top50", alertTypes: { dews: true, depeg: true, safety: true } }));
  });

  it("commits quiet hours on change, disables the colliding hour, and rejects equal start and end locally", async () => {
    const state = makeMiniAppState({ subscriber: { quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7, timezone: "Europe/Paris" } } });
    const fetchMock = await renderReadyMiniApp({ state, launch: { initDataUnsafe: { start_param: "quiet-hours" } } });
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    const fromSelect = screen.getByLabelText("From");
    expect(within(fromSelect).getByRole("option", { name: "07:00 (same as To)" })).toHaveProperty("disabled", true);
    fireEvent.change(fromSelect, { target: { value: "7" } });
    expect(await screen.findByText("Quiet hours need different start and end times.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.change(fromSelect, { target: { value: "23" } });
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-quiet-hours", enabled: true, startHourUtc: 23, endHourUtc: 7 }));
    await waitFor(() => expect(screen.getByRole("switch", { name: switchName("Quiet hours") })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("switch", { name: switchName("Quiet hours") }));
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-quiet-hours", enabled: false }));
  });

  it("states a snooze once in the status strip, keeps inline Resume when blocked or without MainButton", async () => {
    const state = makeMiniAppState({ subscriber: { snoozeUntilTs: 9_000_000_000 } });
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(state)).mockResolvedValueOnce(ok(baseState));
    await renderReadyMiniApp({ fetchImpl: fetchMock });
    expect(screen.getByRole("heading", { name: "Alerts snoozed" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Pause alerts" })).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "Resume alerts" })).getByRole("button"));
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "clear-snooze" }));

    cleanup();
    const main = nativeButton();
    await renderReadyMiniApp({ state, launch: { MainButton: main } });
    await waitFor(() => expect(main.text).toBe("Resume alerts"));
    expect(screen.queryByRole("group", { name: "Resume alerts" })).toBeNull();

    // Blocked + paused: MainButton carries Open PharosWatchBot chat, so inline Resume stays reachable.
    cleanup();
    const blockedMain = nativeButton();
    await renderReadyMiniApp({
      state: makeMiniAppState({ subscriber: { snoozeUntilTs: PAUSE_SENTINEL_TS }, health: { recentFailureClass: "blocked" } }),
      launch: { MainButton: blockedMain, openTelegramLink: vi.fn() },
    });
    await waitFor(() => expect(blockedMain.text).toBe("Open PharosWatchBot chat"));
    expect(screen.getByRole("group", { name: "Resume alerts" })).toBeTruthy();
  });

  it.each(["blocked", "chat_not_found"])("puts the recovery action in the MainButton for %s delivery", async (failureClass) => {
    const main = nativeButton();
    const openTelegramLink = vi.fn();
    await renderReadyMiniApp({ state: makeMiniAppState({ health: { recentFailureClass: failureClass } }), launch: { MainButton: main, openTelegramLink } });
    expect(screen.getByRole("heading", { name: "Telegram stopped delivering alerts" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Alerts on" })).toBeNull();
    await waitFor(() => expect(main.text).toBe("Open PharosWatchBot chat"));
    act(() => main.click());
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=status");
  });

  it("shows one reopen state, keeps controls tappable, never sends, and relaunches the current screen", async () => {
    const main = nativeButton();
    const openTelegramLink = vi.fn();
    const impactOccurred = vi.fn();
    const notificationOccurred = vi.fn();
    const close = vi.fn();
    const fetchMock = await renderReadyMiniApp({
      state: { ...staleAuthState, catalog: rankedCatalog },
      launch: { initDataUnsafe: { start_param: "coin_usdc-circle" }, openTelegramLink, close, MainButton: main, HapticFeedback: { impactOccurred, notificationOccurred } },
    });
    expect(screen.getAllByRole("heading", { name: "Editing paused" })).toHaveLength(1);
    await waitFor(() => expect(main.text).toBe("Reopen to edit"));

    const safety = screen.getByRole("switch", { name: switchName("USDC Safety Score") });
    expect(safety).toHaveProperty("disabled", false);
    fireEvent.click(safety);
    expect(await screen.findByText("Not saved: USDC: Safety Score on. Reopen to edit.")).toBeTruthy();
    // The intent lives in the snackbar only; the banner stays a single reopen notice.
    expect(screen.queryByText("Not saved: USDC: Safety Score on.")).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Editing paused" })).toHaveLength(1);
    expect(notificationOccurred).toHaveBeenCalledWith("warning");
    expect(fetchMock).toHaveBeenCalledOnce();

    act(() => main.click());
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?startapp=coin_usdc-circle");
    expect(impactOccurred).toHaveBeenCalledWith("light");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps refreshing readable state after the 5-minute edit window and routes edits to reopen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const main = nativeButton();
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(baseState)).mockResolvedValue(ok(staleAuthState));
    renderMiniApp({ fetchImpl: fetchMock, launch: { MainButton: main, openTelegramLink: vi.fn() } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(fetchMock).toHaveBeenCalledOnce();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    // Refresh once across the edit deadline, then again after the server confirms expiry.
    for (const calls of [2, 3]) {
      act(() => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1); });
      act(() => {
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      expect(screen.getByRole("heading", { name: "Editing paused" })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: /^All stablecoins/ }));
    fireEvent.click(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }));
    expect(screen.getByText("Not saved: All stablecoins: Safety Score on. Reopen to edit.")).toBeTruthy();
    expect(main.text).toBe("Reopen to edit");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ends the session when a signed preview read hits stale-auth", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(baseState))
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "expired", code: "stale-auth" }) });
    await renderReadyMiniApp({ fetchImpl: fetchMock });
    fireEvent.click(screen.getByRole("button", { name: "Add coins" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "USDT Tether" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 coin" }));
    expect(await screen.findByRole("heading", { name: "This window has expired" })).toBeTruthy();
    hideFor(60 * 60 * 1000);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an expired session read as terminal instead of retrying the same initData", async () => {
    const close = vi.fn();
    const openTelegramLink = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "expired", code: "stale-auth" }) });
    renderMiniApp({ fetchImpl: fetchMock, launch: { close, openTelegramLink } });

    expect(await screen.findByRole("heading", { name: "This window has expired" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    hideFor(60 * 60 * 1000);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledOnce();

    // Without a native MainButton the inline relaunch carries the same deep link.
    fireEvent.click(screen.getByRole("button", { name: "Reopen to edit" }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?startapp=home");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("routes a stale-auth mutation to the reopen state without a session retry", async () => {
    const fetchMock = await renderReadyMiniApp({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(ok(makeMiniAppState({ catalog: rankedCatalog })))
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "expired", code: "stale-auth" }) }),
      launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } },
    });
    fireEvent.click(screen.getByRole("switch", { name: switchName("USDC Safety Score") }));
    expect(await screen.findByRole("heading", { name: "Editing paused" })).toBeTruthy();
    expect(screen.getByText("Not saved: USDC: Safety Score on. Reopen to edit.")).toBeTruthy();
    expect(screen.getByRole("switch", { name: switchName("USDC Safety Score") }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: switchName("USDC Reserve drift") }));
    expect(await screen.findByText("Not saved: USDC: Reserve drift on. Reopen to edit.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps last-known state read-only through a refresh failure until retry", async () => {
    const state = makeMiniAppState({ catalog: rankedCatalog });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(state))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "offline", code: "internal" }) })
      .mockResolvedValueOnce(ok(state));
    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });
    hideFor(10 * 60 * 1000 + 1);
    expect(await screen.findByRole("heading", { name: "Couldn't refresh" })).toBeTruthy();
    expect(screen.getByText(/Pharos is busy right now/)).toBeTruthy();
    expect(screen.queryByText(/state-v1-/)).toBeNull();
    expect(screen.getByRole("switch", { name: switchName("USDC Safety Score") })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Couldn't refresh" })).toBeNull());
    expect(screen.getByRole("switch", { name: switchName("USDC Safety Score") })).toHaveProperty("disabled", false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps one successful mutation wired through the page and replaces its visible state", async () => {
    const nextState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } } };
    let resolveMutation!: (response: ReturnType<typeof ok>) => void;
    const mutationResponse = new Promise<ReturnType<typeof ok>>((resolve) => { resolveMutation = resolve; });
    const fetchMock = await renderReadyMiniApp({ fetchImpl: vi.fn().mockResolvedValueOnce(ok(baseState)).mockReturnValueOnce(mutationResponse) });
    fireEvent.click(screen.getByRole("button", { name: /^All stablecoins/ }));
    const safety = screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") });
    fireEvent.click(safety);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(safety.getAttribute("aria-checked")).toBe("false");
    expect(safety.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("switch", { name: switchName("All stablecoins Reserve drift") })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("switch", { name: /Launch/ })).toBeNull();
    resolveMutation(ok(nextState));
    await waitFor(() => expect(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("All stablecoins: Safety Score on.")).toBeTruthy();
    expectMutationRequest(fetchMock, { kind: "set-global", alertType: "safety", enabled: true });
  });

  it("shows an ambiguous failure with inline Refresh without changing confirmed state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(baseState))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "x", code: "internal" }) })
      .mockResolvedValueOnce(ok(baseState));
    await renderReadyMiniApp({ fetchImpl: fetchMock });
    fireEvent.click(screen.getByRole("button", { name: /^All stablecoins/ }));
    fireEvent.click(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }));
    await waitFor(() => expect(screen.getByText("Couldn't confirm this change.")).toBeTruthy());
    expectMutationRequest(fetchMock, { kind: "set-global", alertType: "safety", enabled: true }, 2);
    expect(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2]?.[0])).toMatch(/^\/api\/telegram-mini-app\/session\?/);
    expect(screen.queryByText("Couldn't confirm this change.")).toBeNull();
  });

  it("keeps same-coin sibling controls interactive while coalescing, guards cross-entity writes, and survives stale-auth repeat & 409 update", async () => {
    const first = Promise.withResolvers<ReturnType<typeof ok>>();
    const second = Promise.withResolvers<ReturnType<typeof ok>>();
    const coinState = makeMiniAppState({ catalog: rankedCatalog });
    const afterSafety = makeMiniAppState({
      catalog: rankedCatalog,
      subscriptions: [{ ...coinState.subscriptions[0]!, alertTypes: { ...coinState.subscriptions[0]!.alertTypes, safety: true }, alertOverrides: { dews: true, depeg: true, safety: true, launch: false, reserve: false, freeze: false } }],
    });
    const afterBoth = makeMiniAppState({
      catalog: rankedCatalog,
      subscriptions: [{ ...afterSafety.subscriptions[0]!, alertTypes: { ...afterSafety.subscriptions[0]!.alertTypes, reserve: true }, alertOverrides: { ...afterSafety.subscriptions[0]!.alertOverrides!, reserve: true } }],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(coinState))
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });
    const safety = screen.getByRole("switch", { name: switchName("USDC Safety Score") });
    const reserve = screen.getByRole("switch", { name: switchName("USDC Reserve drift") });
    fireEvent.click(safety);
    expect(safety.getAttribute("aria-checked")).toBe("false");
    expect(safety.getAttribute("aria-busy")).toBe("true");
    // Sibling switch on the same coin stays enabled and queues cleanly.
    expect(reserve).toHaveProperty("disabled", false);
    fireEvent.click(reserve);
    expect(reserve.getAttribute("aria-checked")).toBe("false");
    expect(reserve.getAttribute("data-queued")).toBe("true");
    // Navigating back shows a saving cue for the other entity while draining.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Saving USDC changes…")).toBeTruthy();
    await act(async () => { first.resolve(ok(afterSafety)); await Promise.resolve(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expectMutationRequest(fetchMock, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { reserve: true } } }, 3);
    await act(async () => { second.resolve(ok(afterBoth)); await Promise.resolve(); });
    await waitFor(() => expect(screen.queryByText("Saving USDC changes…")).toBeNull());

    // Dismissing stale-auth snackbar and repeating the same edit re-shows it; missing openTelegramLink/close renders bot link fallback.
    cleanup();
    await renderReadyMiniApp({ state: { ...staleAuthState, catalog: rankedCatalog }, launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } } });
    expect(screen.getByRole("link", { name: /Open PharosWatchBot/ })).toBeTruthy();
    const staleSafety = screen.getByRole("switch", { name: switchName("USDC Safety Score") });
    fireEvent.click(staleSafety);
    expect(await screen.findByText("Not saved: USDC: Safety Score on. Reopen to edit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Not saved: USDC: Safety Score on. Reopen to edit.")).toBeNull();
    fireEvent.click(staleSafety);
    expect(await screen.findByText("Not saved: USDC: Safety Score on. Reopen to edit.")).toBeTruthy();

    // Persistent 409 version mismatch enters terminal Update required banner + Reopen MainButton (openTelegramLink + close).
    cleanup();
    const main = nativeButton();
    const openTelegramLink = vi.fn();
    const close = vi.fn();
    window.sessionStorage.setItem("pharos-mini-app-version-refresh", "99:catalog-v99");
    await renderReadyMiniApp({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(ok(baseState))
        .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "v", code: "contract-version-mismatch", contractVersion: "99", catalogVersion: "catalog-v99" }) }),
      launch: { MainButton: main, openTelegramLink, close },
    });
    fireEvent.click(screen.getByRole("button", { name: /^All stablecoins/ }));
    fireEvent.click(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }));
    expect(await screen.findByRole("heading", { name: "Update required" })).toBeTruthy();
    await waitFor(() => expect(main.text).toBe("Reopen"));
    act(() => main.click());
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?startapp=home");
    expect(close).toHaveBeenCalledOnce();

    // 409 stale-bulk-preview triggers read-only session refresh and reconciles AddCoinsScreen draft.
    cleanup();
    const driftMain = nativeButton();
    const usdtFollowedState = makeMiniAppState({
      catalog: rankedCatalog,
      subscriptions: [
        ...coinState.subscriptions,
        { ...coinState.subscriptions[0]!, stablecoinId: "usdt-tether", symbol: "USDT", name: "Tether" },
      ],
    });
    const driftFetch = vi.fn()
      .mockResolvedValueOnce(ok(coinState))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "stale", code: "stale-bulk-preview" }) })
      .mockResolvedValueOnce(ok(usdtFollowedState));
    await renderReadyMiniApp({ fetchImpl: driftFetch, launch: { MainButton: driftMain } });
    fireEvent.click(screen.getByRole("button", { name: "Add coins" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "USDT Tether" }));
    await waitFor(() => expect(driftMain.text).toBe("Add 1 coin"));
    act(() => driftMain.click());
    await waitFor(() => expect(driftFetch).toHaveBeenCalledTimes(3));
    expect(String(driftFetch.mock.calls[2]?.[0])).toMatch(/^\/api\/telegram-mini-app\/session\?/);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "USDT Tether, following" }).getAttribute("aria-checked")).toBe("true"));
    expect(driftMain.isVisible).toBe(false);
  });

  it.each<[string, number | null, string | null]>([
    ["future", 1_800_000_001, "Resume alerts"],
    ["exactly expired", 1_800_000_000, null],
    ["unset", null, null],
    ["pause sentinel", PAUSE_SENTINEL_TS, "Resume alerts"],
  ])("uses the shared clock for %s snooze in Home and the native MainButton", async (_scenario, snoozeUntilTs, label) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const main = nativeButton();
    const fetchMock = renderMiniApp({ state: { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs } }, launch: { MainButton: main } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    if (label != null) {
      expect(main.text).toBe(label);
      expect(screen.queryByRole("group", { name: "Pause alerts" })).toBeNull();
    } else {
      expect(screen.getByRole("group", { name: "Pause alerts" })).toBeTruthy();
      expect(main.show).not.toHaveBeenCalled();
      expect(main.onClick).not.toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps delivery ages advancing while the session stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const nowSec = 1_800_000_000;
    const fetchMock = renderMiniApp({
      state: makeMiniAppState({ health: { lastSuccessfulDeliveryAt: nowSec - 60, lastSuccessfulReplyAt: null } }),
      launch: { initDataUnsafe: { start_param: "settings" } },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText("1 min ago")).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(screen.getByText("11 min ago")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows both delivery clocks as 'Not yet' when diagnostics are available but unobserved", async () => {
    renderMiniApp({
      state: makeMiniAppState({ health: { diagnosticsAvailable: true, lastSuccessfulDeliveryAt: null, lastSuccessfulReplyAt: null } }),
      launch: { initDataUnsafe: { start_param: "settings" } },
    });
    await waitFor(() => expect(screen.getByText("Delivery")).toBeTruthy());
    expect(screen.getByText("Last alert delivered")).toBeTruthy();
    expect(screen.getByText("Last reply from the bot")).toBeTruthy();
    expect(screen.getAllByText("Not yet")).toHaveLength(2);
  });

  it("shows an unavailable dash and explanation when diagnostics could not be read", async () => {
    renderMiniApp({
      state: makeMiniAppState({ health: { diagnosticsAvailable: false, lastSuccessfulDeliveryAt: null, lastSuccessfulReplyAt: null } }),
      launch: { initDataUnsafe: { start_param: "settings" } },
    });
    await waitFor(() => expect(screen.getByText("Delivery")).toBeTruthy());
    expect(screen.getByText("Last alert delivered")).toBeTruthy();
    expect(screen.getByText("Last reply from the bot")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("Delivery status can't be read right now.")).toBeTruthy();
  });

  it("restores the Pause chip and detaches the native MainButton exactly at expiry without a POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const main = nativeButton();
    const fetchMock = renderMiniApp({ state: { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs: 1_800_000_002 } }, launch: { MainButton: main } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(main.text).toBe("Resume alerts");
    const attached = main.callbacks.at(-1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_980); });
    expect(screen.getByRole("group", { name: "Pause alerts" })).toBeTruthy();
    expect(main.offClick).toHaveBeenCalledWith(attached);
    expect(main.isVisible).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never stacks native MainButton listeners across state transitions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const main = nativeButton();
    const liveCounts: number[] = [];
    main.onClick.mockImplementation((callback: () => void) => { main.callbacks.push(callback); main.live.add(callback); liveCounts.push(main.live.size); });
    const snoozedState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs: 9_000_000_000 } };
    const clearedState: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs: null } };
    const fetchMock = mockStateResponses(newUserState, snoozedState, clearedState);
    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { MainButton: main } });
    await waitFor(() => expect(main.text).toBe("Follow USD Top 25"));
    act(() => main.click());
    await waitFor(() => expect(main.text).toBe("Resume alerts"));
    act(() => main.click());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(main.live.size).toBe(0);
    });
    expect(Math.max(...liveCounts)).toBe(1);
    expect(new Set(main.callbacks).size).toBe(main.callbacks.length);
  });

  it("guards duplicate native MainButton clicks while its mutation is in flight", async () => {
    const main = nativeButton();
    let resolveMutation!: (value: ReturnType<typeof ok>) => void;
    const mutationResponse = new Promise<ReturnType<typeof ok>>((resolve) => { resolveMutation = resolve; });
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(newUserState)).mockReturnValueOnce(mutationResponse);
    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { MainButton: main } });
    await waitFor(() => expect(main.text).toBe("Follow USD Top 25"));
    const handler = main.callbacks.at(-1)!;
    act(() => { handler(); handler(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveMutation(ok(baseState));
    await waitFor(() => expect(screen.getByText("Following USD Top 25: early warnings and depegs.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("supports Escape and inline Back fallback, and arms closing confirmation for dirty Add coins drafts", async () => {
    const enableClosingConfirmation = vi.fn();
    const disableClosingConfirmation = vi.fn();
    await renderReadyMiniApp({
      state: makeMiniAppState({ catalog: rankedCatalog }),
      launch: { enableClosingConfirmation, disableClosingConfirmation },
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("heading", { level: 1, name: "Alerts on" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add coins" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "USDT Tether" }));
    expect(enableClosingConfirmation).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { level: 1, name: "Alerts on" })).toBeTruthy();
    expect(disableClosingConfirmation).toHaveBeenCalled();
  });
});

describe("Mini App confirmed watcher status", () => {
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

  it.each([
    [emptyState, "Get stablecoin alerts in this chat"],
    [makeMiniAppState({ subscriber: { snoozeUntilTs: 4_102_444_800 } }), "Alerts paused"],
    [makeMiniAppState({ subscriber: { snoozeUntilTs: 9_000_000_000 } }), "Alerts snoozed"],
    [makeMiniAppState({ health: { recentFailureClass: "blocked" } }), "Telegram stopped delivering alerts"],
    [makeMiniAppState({ health: { recentFailureClass: "chat_not_found" } }), "Telegram stopped delivering alerts"],
    [makeMiniAppState(), "Alerts on"],
  ])("classifies the confirmed session as %#: %s", async (state, heading) => {
    launch(state);
    await waitFor(() => expect(screen.getByRole("heading", { name: heading })).toBeTruthy());
    if (heading !== "Alerts on") expect(screen.queryByRole("heading", { name: "Alerts on" })).toBeNull();
  });

  it.each(["bad_request", "formatting_error", "payload_too_large", "auth_error", "chat_migrated"])(
    "does not promise a retry for the non-retryable failure class %s",
    async (failureClass) => {
      launch(makeMiniAppState({ health: { recentFailureClass: failureClass } }));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Last delivery failed" })).toBeTruthy());
      expect(screen.queryByText(/retry automatically/i)).toBeNull();
    },
  );

  it("stops claiming active alerts after confirmed unsubscribe-all retains the subscriber", async () => {
    const operations = launch(makeMiniAppState(), emptyState);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alerts on" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // Without native confirm sheets the destructive row needs a second tap.
    fireEvent.click(screen.getByRole("button", { name: /^Unsubscribe from all alerts/ }));
    expect(operations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /^Tap again to unsubscribe from all/ }));
    await waitFor(() => expect(screen.getByText("Unsubscribed from all alerts.")).toBeTruthy());
    expect(operations).toEqual([{ kind: "unsubscribe-all" }]);
    // Delivery history stays visible independently of coverage; Unsubscribe hides once empty.
    expect(screen.getByText("Last alert delivered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Unsubscribe from all alerts/ })).toBeNull();
  });
});
