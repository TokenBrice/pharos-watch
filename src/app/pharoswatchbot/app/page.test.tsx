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
  await waitFor(() => expect(screen.getByText(/Pharos stores your Telegram user ID/)).toBeTruthy());
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
  let text: string | undefined;
  return {
    callbacks,
    live,
    get isVisible() { return visible; },
    get text() { return visible ? text : undefined; },
    show: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    onClick: vi.fn((callback: () => void) => { callbacks.push(callback); live.add(callback); }),
    offClick: vi.fn((callback: () => void) => { live.delete(callback); }),
    setParams: vi.fn((params: { text?: string; is_visible?: boolean }) => {
      if (params.text != null) text = params.text;
      if (params.is_visible != null) visible = params.is_visible;
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
    fireEvent.click(screen.getByRole("button", { name: "Delete all my data" }));
    act(() => { confirmations.shift()?.(true); });
    act(() => { confirmations.shift()?.(true); });
    await waitFor(() => expect(screen.getByText("Your data has been deleted")).toBeTruthy());
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
    expect(miniAppErrorMessage(new MiniAppRequestError(429, "rate-limited", 12), "mutation"))
      .toBe("Too many changes in a row. Wait a few seconds, then try again.");
    expect(isMiniAppErrorCode("stale-recap-preference")).toBe(false);
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
    const fetchMock = vi.fn().mockResolvedValue(ok(baseState));
    installMiniAppFetch(fetchMock);

    render(<PharosWatchBotMiniAppPage />);
    const script = document.querySelector<HTMLScriptElement>('script[src="https://telegram.org/js/telegram-web-app.js"]');
    expect(script).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(fetchMock).not.toHaveBeenCalled();

    window.Telegram = { WebApp: { initData: "signed-init-data", platform: "tdesktop", initDataUnsafe: { user: { username: "watcher" } }, ready: vi.fn() } };
    await act(async () => {
      script?.dispatchEvent(new Event("load"));
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Alerts on" })).toBeTruthy();
    const sessionUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://pharos.watch");
    expect(sessionUrl.pathname).toBe("/api/telegram-mini-app/session");
    expect(sessionUrl.searchParams.get(TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM)).toBe(TELEGRAM_MINI_APP_CONTRACT_VERSION);
    expect(sessionUrl.searchParams.get(TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM)).toBe(TELEGRAM_MINI_APP_CATALOG_VERSION);
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

  it("offers a bot link or close action when launch data never arrives", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/pharoswatchbot/app/#tgWebAppData=signed-init-data&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop");
    const fetchMock = vi.fn();
    installMiniAppFetch(fetchMock);
    render(<PharosWatchBotMiniAppPage />);
    await act(async () => { vi.advanceTimersByTime(8_050); });
    expect(screen.getByRole("link", { name: "Open PharosWatchBot" }).getAttribute("href")).toBe("https://t.me/PharosWatchBot");

    cleanup();
    const close = vi.fn();
    window.Telegram = { WebApp: { initData: "", platform: "tdesktop", ready: vi.fn(), close } };
    render(<PharosWatchBotMiniAppPage />);
    await act(async () => { vi.advanceTimersByTime(8_050); });
    expect(screen.getByText("Telegram didn't pass your launch details. Close and reopen from PharosWatchBot.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close and reopen" }));
    expect(close).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
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
    for (const section of ["Coverage", "Your coins", "Make it quieter"]) expect(screen.getByRole("heading", { name: section })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^USD Top 25/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^All stablecoins/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "USDC, DEWS · Depeg" })).toBeTruthy();
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
    ["settings", "Settings"],
    ["quiet-hours", "Settings"],
    ["forget", "Settings"],
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
    await waitFor(() => expect(main.text).toBe("Use recommended setup"));
    // One primary action, never mirrored inline.
    expect(screen.queryByRole("button", { name: "Use recommended setup" })).toBeNull();

    for (const state of [newUserState, baseState]) {
      cleanup();
      const back = nativeButton();
      await renderReadyMiniApp({ state, launch: { BackButton: back, initDataUnsafe: { start_param: "setup" } } });
      expect(await screen.findByLabelText("Search stablecoins")).toBeTruthy();
      await waitFor(() => expect(back.isVisible).toBe(true));
    }
  });

  it("hides every edit control for a read-only group chat", async () => {
    const main = nativeButton();
    const state = makeMiniAppState({ viewer: { chatId: null, chatType: "supergroup", canMutate: false, mutationBlockReason: "not-private" }, subscriber: { exists: false } });
    await renderReadyMiniApp({ state, launch: { MainButton: main } });
    expect(screen.getByRole("heading", { name: "Group alerts are managed in the group" })).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add coins" })).toBeNull();
    expect(main.isVisible).toBe(false);
  });

  it("explains coin coverage: on, via a group, muted, and unknown membership", async () => {
    const coin = { ...baseState.subscriptions[0]!, alertTypes: { ...baseState.subscriptions[0]!.alertTypes, depeg: false }, alertOverrides: { dews: false, depeg: true, safety: false, launch: false, reserve: false, freeze: false } };
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
    expect(sw("Early warning").getAttribute("aria-checked")).toBe("true");
    expect(sw("Depeg").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Muted for USDC (USD Top 25 covers it)")).toBeTruthy();
    expect(sw("Safety Score").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("On via USD Top 25")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Launch/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /View on Pharos/ }));
    expect(openLink).toHaveBeenCalledWith("https://pharos.watch/stablecoin/usdc-circle");
    fireEvent.click(screen.getByRole("button", { name: /Explain in chat/ }));
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot?start=why_usdc-circle");

    // Turning an inherited family off writes the per-coin mute.
    fireEvent.click(sw("Safety Score"));
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { safety: false } } }));

    cleanup();
    await renderReadyMiniApp({
      state: { ...state, presets: [top25({ safety: true }, null)] },
      launch: { initDataUnsafe: { start_param: "coin_usdc-circle" } },
    });
    expect(screen.getByRole("switch", { name: switchName("USDC Safety Score") }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Can't check USD Top 25 coverage right now")).toBeTruthy();
  });

  it("follows an unfollowed coin from the MainButton and leaves unknown coins untouched", async () => {
    const main = nativeButton();
    const fetchMock = await renderReadyMiniApp({ state: makeMiniAppState({ catalog: rankedCatalog }), launch: { MainButton: main, initDataUnsafe: { start_param: "coin_usdt-tether" } } });
    expect(screen.getByText("Not in your coins yet.")).toBeTruthy();
    // Read-only until followed: no switch could silently follow it, and no snooze row.
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: /Snooze USDT/ })).toBeNull();
    expect(screen.getByText("Follow USDT to choose its alerts.")).toBeTruthy();
    // Early warning and Depeg come from All stablecoins in the fixture.
    expect(screen.getAllByText("On")).toHaveLength(2);
    expect(screen.getAllByText("Off")).toHaveLength(3);
    await waitFor(() => expect(main.text).toBe("Follow USDT"));
    act(() => main.click());
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-coin", stablecoinId: "usdt-tether", patch: { alertTypes: { dews: true, depeg: true } } }));

    cleanup();
    const unknownMain = nativeButton();
    const unknownFetch = await renderReadyMiniApp({ launch: { MainButton: unknownMain, initDataUnsafe: { start_param: "coin_old-coin" } } });
    expect(screen.getByText("Nothing to change")).toBeTruthy();
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

  it("commits quiet hours on change and rejects equal start and end locally", async () => {
    const state = makeMiniAppState({ subscriber: { quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7, timezone: "Europe/Paris" } } });
    const fetchMock = await renderReadyMiniApp({ state, launch: { initDataUnsafe: { start_param: "quiet-hours" } } });
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "7" } });
    expect(await screen.findByText("Quiet hours need different start and end times.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "23" } });
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-quiet-hours", enabled: true, startHourUtc: 23, endHourUtc: 7 }));
    await waitFor(() => expect(screen.getByRole("switch", { name: switchName("Quiet hours") })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("switch", { name: switchName("Quiet hours") }));
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "set-quiet-hours", enabled: false }));
  });

  it("states a snooze once, in the status strip, with an inline Resume only without a MainButton", async () => {
    const state = makeMiniAppState({ subscriber: { snoozeUntilTs: 9_000_000_000 } });
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(state)).mockResolvedValueOnce(ok(baseState));
    await renderReadyMiniApp({ fetchImpl: fetchMock });
    expect(screen.getByRole("heading", { name: "Alerts snoozed" })).toBeTruthy();
    expect(screen.queryByText(/^Snoozed until/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Snooze all alerts for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause until I resume" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Quiet hours/ })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Resume alerts" })).getByRole("button"));
    await waitFor(() => expectMutationRequest(fetchMock, { kind: "clear-snooze" }));

    cleanup();
    const main = nativeButton();
    await renderReadyMiniApp({ state, launch: { MainButton: main } });
    await waitFor(() => expect(main.text).toBe("Resume alerts"));
    expect(screen.queryByRole("group", { name: "Resume alerts" })).toBeNull();
  });

  it("puts the recovery action in the MainButton for blocked delivery", async () => {
    const main = nativeButton();
    const openTelegramLink = vi.fn();
    await renderReadyMiniApp({ state: makeMiniAppState({ health: { recentFailureClass: "blocked" } }), launch: { MainButton: main, openTelegramLink } });
    expect(screen.getByRole("heading", { name: "Telegram stopped delivering alerts" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Alerts on" })).toBeNull();
    await waitFor(() => expect(main.text).toBe("Open chat with PharosWatchBot"));
    act(() => main.click());
    expect(openTelegramLink).toHaveBeenCalledWith("https://t.me/PharosWatchBot");
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
    const main = nativeButton();
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(baseState)).mockResolvedValueOnce(ok(staleAuthState));
    await renderReadyMiniApp({ fetchImpl: fetchMock, launch: { MainButton: main, openTelegramLink: vi.fn() } });
    hideFor(10 * 60 * 1000 + 1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(await screen.findByRole("heading", { name: "Editing paused" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /^All stablecoins/ }));
    fireEvent.click(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }));
    expect(await screen.findByText("Not saved: All stablecoins: Safety Score on. Reopen to edit.")).toBeTruthy();
    await waitFor(() => expect(main.text).toBe("Reopen to edit"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    fireEvent.click(screen.getByRole("switch", { name: switchName("USDC Reserve changes") }));
    expect(await screen.findByText("Not saved: USDC: Reserve changes on. Reopen to edit.")).toBeTruthy();
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
    expect(screen.getByRole("switch", { name: switchName("All stablecoins Reserve changes") })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("switch", { name: /Launch/ })).toBeNull();
    resolveMutation(ok(nextState));
    await waitFor(() => expect(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("All stablecoins: Safety Score on.")).toBeTruthy();
    expectMutationRequest(fetchMock, { kind: "set-global", alertType: "safety", enabled: true });
  });

  it("shows a failed mutation in the snackbar without changing confirmed state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(baseState))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "x", code: "internal" }) });
    await renderReadyMiniApp({ fetchImpl: fetchMock });
    fireEvent.click(screen.getByRole("button", { name: /^All stablecoins/ }));
    fireEvent.click(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }));
    await waitFor(() => expect(screen.getByText("Something went wrong. Nothing was saved; try again.")).toBeTruthy());
    expectMutationRequest(fetchMock, { kind: "set-global", alertType: "safety", enabled: true });
    expect(screen.getByRole("switch", { name: switchName("All stablecoins Safety Score") }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Something went wrong. Nothing was saved; try again.")).toBeNull();
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
      expect(screen.queryByRole("button", { name: /Snooze all alerts for/ })).toBeNull();
    } else {
      expect(screen.getByRole("button", { name: "Snooze all alerts for 1 hour" })).toBeTruthy();
      expect(main.show).not.toHaveBeenCalled();
      expect(main.onClick).not.toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("restores snooze choices and detaches the native MainButton exactly at expiry without a POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const main = nativeButton();
    const fetchMock = renderMiniApp({ state: { ...baseState, subscriber: { ...baseState.subscriber, snoozeUntilTs: 1_800_000_002 } }, launch: { MainButton: main } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(main.text).toBe("Resume alerts");
    const attached = main.callbacks.at(-1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_980); });
    expect(screen.getByRole("button", { name: "Snooze all alerts for 1 hour" })).toBeTruthy();
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
    await waitFor(() => expect(main.text).toBe("Use recommended setup"));
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
    await waitFor(() => expect(main.text).toBe("Use recommended setup"));
    const handler = main.callbacks.at(-1)!;
    act(() => { handler(); handler(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveMutation(ok(baseState));
    await waitFor(() => expect(screen.getByText("Following USD Top 25: early warnings and depegs.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
