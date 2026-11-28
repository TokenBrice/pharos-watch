// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor as wf, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION as CAT_V,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM as CAT_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION as CON_V,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM as CON_PARAM,
  createTelegramMiniAppSnapshot as mkSnap,
} from "@shared/lib/telegram-mini-app-contract";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { isMiniAppErrorCode, miniAppErrorMessage, MiniAppRequestError } from "./error-messages";
import PharosWatchBotMiniAppPage, { metadata } from "./page";
import { baseState, makeMiniAppState as mkState } from "@shared/test-utils/telegram-mini-app-state";
import type { TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { installMatchMediaMock } from "@/test-utils/frontend";
import { PharosWatchBotMiniAppClient } from "./client";

type MiniAppWebApp = NonNullable<NonNullable<Window["Telegram"]>["WebApp"]>;
type MockFn = ReturnType<typeof vi.fn>;
interface ResLike { ok: boolean; status?: number; headers?: Headers; json(): Promise<unknown>; }
type RenderOpts = { state?: TelegramMiniAppState; launch?: Partial<MiniAppWebApp>; startParam?: string; fetchImpl?: MockFn };

const BOT = "https://t.me/PharosWatchBot", INIT = "signed-init-data", NOW = 1_800_000_000;
const USDC = "usdc-circle", USDT = "usdt-tether", USD0 = "usd0-usual", C_USDC = `coin_${USDC}`, FP = "preview-v1-12-deadbeef";
const H_ON = "Alerts on", H_EDIT = "Editing paused", L_REOPEN = "Reopen to edit", L_RESUME = "Resume alerts", L_PAUSE = "Pause alerts";
const L_SEARCH = "Search stablecoins", L_ADD = "Add coins", L_SET = "Settings", L_PRESET = "Follow a preset", L_TOP25 = "USD Top 25";
const L_CANT = "Couldn't confirm this change.", L_USDC_S = "USDC Safety Score", L_ALL_S = "All stablecoins Safety Score", L_USDC_R = "USDC Reserve drift";
const L_UNSAVED = "Not saved: USDC: Safety Score on. Reopen to edit.", L_UNREAD = "Can't check USD Top 25 coverage right now";
const L_PREV = "PharosWatchBot app preview", L_CHAT = "Open PharosWatchBot chat", L_EXP = "This window has expired", L_REF = "Couldn't refresh";
const L_ADD1 = "Add 1 coin", L_ADD2 = "Add 2 coins", L_SAVE2 = "Save 2 changes", R_ALL = /^All stablecoins/;
const C_USDT = "USDT Tether", C_FOL = "USDC USD Coin, following", C_REM = "USDC USD Coin, will be removed", C_USD0 = "USD0 Usual USD";
const ALL_OFF = { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false } as const;
const okProv = { status: "ok", source: "s", assessedAt: NOW, observedAt: NOW, generation: "g", budgetSec: 1200 } as const;
const unavailProv = { status: "unavailable", source: "s", assessedAt: NOW, observedAt: null, generation: null, budgetSec: 1200, reason: "missing" } as const;
const ok = (body: unknown) => ({ ok: true, json: async () => body });
const fail = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body });
const staleFail = () => fail(401, { error: "expired", code: "stale-auth" });
const ver = (body: Record<string, unknown>) => ({ contractVersion: CON_V, catalogVersion: CAT_V, serverNowSec: NOW, ...body });
const seq = (...res: unknown[]): MockFn => res.reduce<MockFn>((m, r) => m.mockResolvedValueOnce(r), vi.fn());
const deferOk = () => Promise.withResolvers<ReturnType<typeof ok>>();
const withSub = (subscriber: Parameters<typeof mkState>[0]["subscriber"]) => mkState({ subscriber });
const withHealth = (health: Parameters<typeof mkState>[0]["health"]) => mkState({ health });
const withSnooze = (snoozeUntilTs: number | null) => withSub({ snoozeUntilTs });
const staleState: TelegramMiniAppState = { ...baseState, viewer: { ...baseState.viewer, canMutate: false, mutationBlockReason: "stale-auth" } };
const newUser = withSub({ exists: false, snoozeUntilTs: null });
const top25 = (alertTypes: Partial<TelegramMiniAppState["presets"][number]["alertTypes"]>, memberIds: string[] | null) => ({
  id: "usd-top25" as const, label: L_TOP25, alertTypes: { dews: false, depeg: false, safety: false, ...alertTypes }, depegStepBps: null, memberIds,
});
const rankedCatalog: TelegramMiniAppState["catalog"] = {
  recommendedPresets: [{ id: "usd-top25", label: L_TOP25 }, { id: "usd-top50", label: "USD Top 50" }],
  searchableCoins: [
    { stablecoinId: USD0, symbol: "USD0", name: "Usual USD", peg: "USD", rank: 70 },
    { stablecoinId: USDC, symbol: "USDC", name: "USD Coin", peg: "USD", rank: 6 },
    { stablecoinId: USDT, symbol: "USDT", name: "Tether", peg: "USD", rank: 1 },
  ],
};
const ranked = (o?: Parameters<typeof mkState>[0]) => mkState({ catalog: rankedCatalog, ...o });
const rankedStale: TelegramMiniAppState = { ...staleState, catalog: rankedCatalog };
const setCoinOp = (patch: Record<string, unknown>, stablecoinId = USDC) => ({ kind: "set-coin", stablecoinId, patch } as TelegramMiniAppOperation);
const isRes = (v: unknown): v is ResLike => typeof v === "object" && v != null && "ok" in v && typeof v.ok === "boolean" && "json" in v && typeof v.json === "function";

function installFetch(fetchImpl: MockFn): void {
  mockFetch([{
    match: "/api/telegram-mini-app/",
    respond: async (req) => {
      const u = new URL(req.url), body = req.body == null ? undefined : await req.clone().text();
      const res: unknown = await (fetchImpl as unknown as (i: string, init: RequestInit) => Promise<unknown>)(`${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body });
      if (res instanceof Response) return res;
      if (!isRes(res)) throw new Error("Mini App fetch fixture must return a response-like value");
      return { body: await res.json(), status: res.status ?? (res.ok ? 200 : 500), headers: res.headers == null ? undefined : Object.fromEntries(res.headers) };
    },
  }], { requireMatch: true });
}

function setTg(launch: Partial<MiniAppWebApp> = {}, startParam?: string): void {
  const { initDataUnsafe = startParam == null ? {} : { start_param: startParam }, ...rest } = launch;
  window.Telegram = {
    WebApp: {
      initData: INIT, ready: vi.fn(), expand: vi.fn(), enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(),
      HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn() }, ...rest,
      initDataUnsafe: { user: { username: "watcher" }, ...initDataUnsafe },
    },
  };
}

function renderMiniApp(opts: RenderOpts = {}): MockFn {
  setTg(opts.launch, opts.startParam);
  const fetchMock = opts.fetchImpl ?? vi.fn().mockResolvedValue(ok(opts.state ?? baseState));
  installFetch(fetchMock);
  render(<PharosWatchBotMiniAppPage />);
  return fetchMock;
}

const renderReady = async (opts: RenderOpts = {}): Promise<MockFn> => {
  const m = renderMiniApp(opts);
  await wf(() => expect(screen.getByRole("heading", { level: 1 })).toBeTruthy());
  return m;
};

function expectMut(m: MockFn, operation: TelegramMiniAppOperation, call?: number): void {
  const url = expect.stringMatching(/^\/api\/telegram-mini-app\/mutate\?/), init = expect.objectContaining({ method: "POST", body: JSON.stringify({ initData: INIT, operation }) });
  if (call == null) expect(m).toHaveBeenLastCalledWith(url, init);
  else expect(m).toHaveBeenNthCalledWith(call, url, init);
}
const waitMut = (m: MockFn, op: TelegramMiniAppOperation, call?: number) => wf(() => expectMut(m, op, call));

function nativeBtn() {
  const callbacks: Array<() => void> = [], live = new Set<() => void>();
  let vis = false, actv = true, txt: string | undefined;
  return {
    callbacks, live,
    get isVisible() { return vis; }, get isActive() { return vis && actv; }, get text() { return vis ? txt : undefined; },
    show: vi.fn(() => { vis = true; }), hide: vi.fn(() => { vis = false; }),
    onClick: vi.fn((cb: () => void) => { callbacks.push(cb); live.add(cb); }),
    offClick: vi.fn((cb: () => void) => { live.delete(cb); }),
    setParams: vi.fn((p: { text?: string; is_visible?: boolean; is_active?: boolean }) => { if (p.text != null) txt = p.text; if (p.is_visible != null) vis = p.is_visible; if (p.is_active != null) actv = p.is_active; }),
    showProgress: vi.fn(), hideProgress: vi.fn(),
    click() { for (const cb of [...live]) cb(); },
  };
}

function mutableState(ov: Parameters<typeof mkState>[0]) { const { catalog: _c, ...m } = mkState(ov); return m; }
function ctxFetch(m: ReturnType<typeof mutableState>, ctx: (req: { kind: string; stablecoinIds?: string[] }) => unknown, mutate?: () => unknown) {
  return vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    const parsed = init?.body ? JSON.parse(String(init.body)) as { contextRequest?: { kind: string; stablecoinIds?: string[] } } : {};
    if (input.includes("/session")) return parsed.contextRequest ? ctx(parsed.contextRequest) : ok(mkSnap(m, NOW));
    if (mutate && input.includes("/mutate")) return mutate();
    throw new Error(`Unexpected call: ${input}`);
  });
}

const coinsCtx = (events: unknown[], coinSignals: Record<string, unknown> = {}, provenance: typeof okProv | typeof unavailProv = okProv) =>
  ok(ver({ context: { kind: "coins", activeDepegs: { provenance, events }, coinSignals } }));
const preview = (adds: string[], removes: string[] = []) => ok({
  contractVersion: CON_V, catalogVersion: CAT_V,
  result: { kind: "bulk-watchlist-preview", expectedPreferenceGeneration: 1, previewFingerprint: FP, adds, removes, unchanged: [], sourceImpact: [], undo: { expectedPreferenceGeneration: 2, expectedFingerprint: FP, restoreDirectRows: [], removeStablecoinIds: adds } },
});

const swName = (l: string) => (n: string) => n === l || n.startsWith(`${l}:`);
const sw = (l: string) => screen.getByRole("switch", { name: swName(l) });
const noSw = (l: string) => expect(screen.queryByRole("switch", { name: swName(l) })).toBeNull();
const btn = (n: string | RegExp) => screen.getByRole("button", { name: n });
const click = fireEvent.click, tap = (n: string | RegExp) => click(btn(n)), tapMain = (b: { click(): void }) => act(() => b.click());
const chk = (n: string | RegExp) => screen.getByRole("checkbox", { name: n });
const grp = (n: string | RegExp) => screen.getByRole("group", { name: n });
const noGrp = (n: string | RegExp) => expect(screen.queryByRole("group", { name: n })).toBeNull();
const hasH = (...ns: Array<string | RegExp>) => { for (const n of ns) expect(screen.getByRole("heading", { name: n })).toBeTruthy(); };
const hasH1 = (n: string | RegExp) => expect(screen.getByRole("heading", { level: 1, name: n })).toBeTruthy();
const noH = (...ns: Array<string | RegExp>) => { for (const n of ns) expect(screen.queryByRole("heading", { name: n })).toBeNull(); };
const findH = async (n: string | RegExp) => expect(await screen.findByRole("heading", { name: n })).toBeTruthy();
const hasT = (...ts: Array<string | RegExp>) => { for (const t of ts) expect(screen.getByText(t)).toBeTruthy(); };
const noT = (...ts: Array<string | RegExp>) => { for (const t of ts) expect(screen.queryByText(t)).toBeNull(); };
const findT = async (t: string | RegExp) => expect(await screen.findByText(t)).toBeTruthy();
const noBtn = (...ns: Array<string | RegExp>) => { for (const n of ns) expect(screen.queryByRole("button", { name: n })).toBeNull(); };
const withMain = (MainButton: ReturnType<typeof nativeBtn>) => ({ MainButton });
const checked = (el: HTMLElement) => el.getAttribute("aria-checked");
const disabled = (el: HTMLElement, v: boolean) => expect(el).toHaveProperty("disabled", v);
const mainIs = (b: { readonly text: string | undefined }, t: string) => wf(() => expect(b.text).toBe(t));
const calls = (m: { mock: { calls: unknown[] } }) => m.mock.calls.length;
const waitCalls = (m: { mock: { calls: unknown[] } }, n: number) => wf(() => expect(calls(m)).toBe(n));
const setPath = (s: string) => window.history.replaceState({}, "", `/pharoswatchbot/app/${s}`);
const freezeNow = () => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); };
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const flush = () => act(async () => { await Promise.resolve(); });
const setInput = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const searchEl = () => screen.getByLabelText(L_SEARCH);
const botHref = () => screen.getByRole("link", { name: /Open PharosWatchBot/ }).getAttribute("href");
const rowOf = (t: string) => within(screen.getAllByText(t)[0]!.closest<HTMLElement>("div.relative")!);
const openWith = (fn: MockFn, q: string) => expect(fn).toHaveBeenCalledWith(`${BOT}?${q}`);
const once = (fn: MockFn) => expect(fn).toHaveBeenCalledOnce();

function hideFor(ms: number): void {
  const now = Date.now(), vis = vi.spyOn(document, "visibilityState", "get");
  vis.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.spyOn(Date, "now").mockReturnValue(now + ms);
  vis.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.sessionStorage.clear(); Reflect.deleteProperty(window, "Telegram"); setPath(""); });

describe("PharosWatchBotMiniAppPage", () => {
  it("makes forget-me terminal for retained native Back, Settings, and Main callbacks", async () => {
    const [back, settings, main, close] = [nativeBtn(), nativeBtn(), nativeBtn(), vi.fn()];
    const cbs: Array<(c: boolean) => void> = [];
    const m = await renderReady({ state: withSnooze(PAUSE_SENTINEL_TS), launch: { BackButton: back, SettingsButton: settings, MainButton: main, close, showConfirm: vi.fn((_m, cb) => { cbs.push(cb); }) } });
    await mainIs(main, L_RESUME);
    const rResume = main.callbacks.at(-1)!;
    tapMain(settings);
    await wf(() => expect(back.isVisible).toBe(true));
    const [rBack, rSettings] = [back.callbacks.at(-1)!, settings.callbacks.at(-1)!];
    tap(/^Delete all my data/);
    act(() => { cbs.shift()?.(true); });
    act(() => { cbs.shift()?.(true); });
    await wf(() => hasT("Your data has been deleted"));
    expect(document.querySelector(".pharos-mini-app")).toBeTruthy();
    expectMut(m, { kind: "forget-me" });
    const n = calls(m);
    act(() => { rBack(); rSettings(); rResume(); });
    await flush();
    expect([calls(m), back.isVisible, settings.isVisible, main.isVisible, screen.getAllByRole("button").length]).toEqual([n, false, false, false, 1]);
    expect(back.offClick).toHaveBeenCalledWith(rBack);
    expect(settings.offClick).toHaveBeenCalledWith(rSettings);
    expect(main.offClick).toHaveBeenCalledWith(rResume);
    tap(/Close/i);
    once(close);
  });

  it("keeps metadata and the Mini App error-code contract", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    for (const bad of ["empty-alert-types", "stale_auth", null, "stale-recap-preference"]) expect(isMiniAppErrorCode(bad)).toBe(false);
    const e = (s: number, c: ConstructorParameters<typeof MiniAppRequestError>[1], r?: number) => new MiniAppRequestError(s, c, r);
    for (const [err, ctx, exp] of [
      [e(429, "rate-limited", 12), "mutation", "Too many changes in a row. Wait a few seconds, then try again."],
      [e(429, "rate-limited", 3), "session", "Still opening. Wait 3 seconds, then try again."],
      [e(400, "invalid-alert-types"), "mutation", "Keep at least one alert on for this preset."],
      [e(400, "invalid-timezone"), "mutation", "That time zone isn't recognized. Pick another from the list."],
      [e(400, "unknown-coin"), "mutation", "That coin isn't available for alerts. Nothing was saved."],
      [e(400, "unknown-preset"), "mutation", "That preset isn't available right now. Nothing was saved."],
      [e(500, "internal"), "mutation", L_CANT],
      [new TypeError("Failed to fetch"), "mutation", L_CANT],
    ] as const) expect(miniAppErrorMessage(err, ctx)).toBe(exp);
  });

  it("renders browser preview without calling session APIs, allowlists startapp, and rejects unsupported hosts", () => {
    const m = vi.fn();
    installFetch(m);
    for (const [q, exp] of [[C_USDC, C_USDC], ["../evil", "home"]] as const) {
      cleanup();
      setPath(`?startapp=${q}`);
      render(<PharosWatchBotMiniAppPage />);
      hasT(L_PREV);
      expect(botHref()).toBe(`${BOT}?startapp=${exp}`);
    }
    vi.useFakeTimers();
    for (const [path, initData] of [["", ""], [`#tgWebAppData=${INIT}&tgWebAppVersion=9.0&tgWebAppPlatform=unknown`, INIT]] as const) {
      cleanup();
      setPath(path);
      window.Telegram = { WebApp: { initData, platform: "unknown", ready: vi.fn() } };
      render(<PharosWatchBotMiniAppPage />);
      hasT(L_PREV);
    }
    expect(m).not.toHaveBeenCalled();
  });

  it("starts hash-based session fetch immediately with late SDK binding, preconnect links, and no-SDK fallback", async () => {
    vi.useFakeTimers();
    setPath(`#tgWebAppData=${INIT}&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop`);
    const m = vi.fn().mockResolvedValue(ok(baseState));
    installFetch(m);
    render(<PharosWatchBotMiniAppPage />);
    for (const s of ['link[rel="preconnect"][href="https://api.pharos.watch"]', 'link[rel="preconnect"][href="https://telegram.org"]', 'script[src="https://telegram.org/js/telegram-web-app.js"]']) expect(document.querySelector(s)).toBeTruthy();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    once(m);
    const u = new URL(String(m.mock.calls[0]?.[0]), "https://pharos.watch");
    expect([u.pathname, u.searchParams.get(CON_PARAM), u.searchParams.get(CAT_PARAM)]).toEqual(["/api/telegram-mini-app/session", CON_V, CAT_V]);
    hasH(H_ON);

    const [ready, settings] = [vi.fn(), nativeBtn()];
    setTg({ platform: "tdesktop", ready, SettingsButton: settings });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect([calls(ready), settings.isVisible, calls(m)]).toEqual([1, true, 1]);

    cleanup();
    Reflect.deleteProperty(window, "Telegram");
    const signed = "auth_date=1800000000&hash=abc&user=%7B%7D", m2 = vi.fn().mockResolvedValue(ok(baseState));
    setPath(`#tgWebAppData=${encodeURIComponent(signed)}&tgWebAppVersion=9.0&tgWebAppPlatform=tdesktop`);
    installFetch(m2);
    render(<PharosWatchBotMiniAppPage />);
    await tick(8_050);
    hasH(H_ON);
    noT("Telegram didn't pass your launch details. Close and reopen from PharosWatchBot.");
    once(m2);
    expect(JSON.parse(String((m2.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ initData: signed });
  });

  it("loads the session into the tab-free Home screen", async () => {
    const [ready, expand] = [vi.fn(), vi.fn()];
    await renderReady({ state: mkState({ presets: [top25({ dews: true, depeg: true }, [USDC])] }), launch: { ready, expand } });
    expect([calls(ready) > 0, calls(expand) > 0, screen.queryAllByRole("tab").length]).toEqual([true, true, 0]);
    noBtn("Refresh session");
    hasH("Presets", "Your coins");
    noH("Make it quieter");
    noT(/Pharos stores your Telegram user ID/);
    for (const b of [/^USD Top 25/, /^All stablecoins/, "USDC, USD Coin, DEWS · Depeg", L_SET]) expect(btn(b)).toBeTruthy();
    expect(grp(L_PAUSE)).toBeTruthy();
  });

  it("shows plain session errors and retries a failed load", async () => {
    renderMiniApp({ fetchImpl: seq(fail(401, { error: "Invalid" })) });
    await wf(() => hasT("Telegram couldn't confirm this window. Close and reopen it from PharosWatchBot."));

    cleanup();
    const main = nativeBtn(), retry = seq(fail(500, { error: "Unavailable" }), ok(baseState));
    renderMiniApp({ fetchImpl: retry, launch: withMain(main) });
    await wf(() => hasT("Couldn't load your alerts. Try again."));
    await mainIs(main, "Try again");
    noBtn("Close and reopen");
    tapMain(main);
    await wf(() => hasH(H_ON));
    expect(calls(retry)).toBe(2);
  });

  it.each([
    [null, H_ON], ["watchlist", H_ON], ["presets", L_PRESET], ["settings", L_SET],
    ["snooze", L_SET], [C_USDC, "USDC"], [`why_${USDC}`, "USDC"], [`coverage_${USDC}`, "USDC"],
  ] as const)("boots start_param %s on its screen", async (startParam, h) => {
    const m = await renderReady(startParam == null ? {} : { startParam });
    hasH1(h);
    once(m);
  });

  it("shows the setup screen to new users and opens coin selection from startapp=setup for everyone", async () => {
    const main = nativeBtn();
    await renderReady({ state: newUser, launch: withMain(main) });
    hasH("Get stablecoin alerts in this chat");
    hasT(/Pharos stores your Telegram user ID/);
    await mainIs(main, `Follow ${L_TOP25}`);
    noBtn(`Follow ${L_TOP25}`, /Send a sample alert/);
    for (const state of [newUser, baseState]) {
      cleanup();
      const back = nativeBtn();
      await renderReady({ state, startParam: "setup", launch: { BackButton: back } });
      expect(await screen.findByLabelText(L_SEARCH)).toBeTruthy();
      await wf(() => expect(back.isVisible).toBe(true));
    }
  });

  it("hides every edit control and SettingsButton for a read-only group chat", async () => {
    const [main, settings, openTg] = [nativeBtn(), nativeBtn(), vi.fn()];
    await renderReady({ state: mkState({ viewer: { chatId: null, chatType: "supergroup", canMutate: false, mutationBlockReason: "not-private" }, subscriber: { exists: false } }), launch: { MainButton: main, SettingsButton: settings, openTelegramLink: openTg } });
    hasH("Group alerts are managed in the group");
    expect([screen.queryAllByRole("switch").length, main.isVisible, settings.isVisible]).toEqual([0, false, false]);
    noBtn(L_ADD);
    tap(/Open your personal alerts/);
    openWith(openTg, "startapp=home");
  });

  it("explains coin coverage: on, via a preset, off override, unknown membership, and legacy safety recovery", async () => {
    const coin = { ...baseState.subscriptions[0]!, alertTypes: { ...baseState.subscriptions[0]!.alertTypes, depeg: false, safety: true }, alertOverrides: { ...ALL_OFF, depeg: true }, safetyMode: "upgrade-only" as const };
    const state = ranked({ subscriber: { globalAlerts: { dews: false, depeg: false } }, subscriptions: [coin], presets: [top25({ dews: true, depeg: true, safety: true }, [USDC])] });
    const [openLink, openTg] = [vi.fn(), vi.fn()];
    const m = await renderReady({ state, startParam: C_USDC, launch: { openLink, openTelegramLink: openTg } });
    expect([checked(sw("USDC Early warning (DEWS)")), checked(sw("USDC Depeg")), checked(sw(L_USDC_S)), screen.queryByLabelText("Changes"), screen.queryByRole("switch", { name: /Launch/ })]).toEqual(["true", "false", "true", null, null]);
    hasT("Off for USDC. USD Top 25 would cover it.");
    hasT("Live downgrade alerts are off");

    tap(/View on Pharos/);
    expect(openLink).toHaveBeenCalledWith(`https://pharos.watch/stablecoin/${USDC}`);
    noBtn(/Send status to chat/);

    click(within(grp("Turn on live downgrade alerts for USDC")).getByRole("button"));
    await waitMut(m, setCoinOp({ safetyMode: null }));

    cleanup();
    const noSafety = { ...coin, alertTypes: { ...coin.alertTypes, safety: false }, safetyMode: null };
    await renderReady({ state: { ...state, subscriptions: [noSafety], presets: [top25({ safety: true }, null)] }, startParam: C_USDC });
    noSw(L_USDC_S);
    expect(rowOf(L_UNREAD).getByText("—")).toBeTruthy();
  });

  it("claims neither coverage nor a mute when a followed preset's members are unreadable", async () => {
    await renderReady({ state: ranked({ subscriber: { globalAlerts: { dews: false, depeg: false, safety: false } }, presets: [top25({ dews: true, safety: true }, null)] }), startParam: `coin_${USDT}` });
    const r = rowOf(L_UNREAD);
    expect([Boolean(r.getByText("—")), r.queryByText("Off"), screen.queryAllByRole("switch").length]).toEqual([true, null, 0]);

    cleanup();
    await renderReady({ state: ranked({ presets: [top25({ safety: true }, null)] }), startParam: C_USDC });
    noSw(L_USDC_S);
    expect(rowOf(L_UNREAD).getByText("—")).toBeTruthy();
  });

  it("customizes covered coins, follows uncovered coins, and offers Browse coins for removed coins", async () => {
    const main = nativeBtn(), m = await renderReady({ state: ranked(), startParam: `coin_${USDT}`, launch: withMain(main) });
    expect([screen.queryAllByRole("switch").length, screen.getAllByText("On").length, screen.getAllByText("Off").length]).toEqual([0, 2, 3]);
    expect(grp("Snooze USDT")).toBeTruthy();
    hasT("Customize USDT to turn alerts off or tune thresholds.");
    await mainIs(main, "Customize USDT");
    tapMain(main);
    await waitMut(m, setCoinOp({ alertTypes: { dews: true, depeg: true } }, USDT));

    cleanup();
    const uMain = nativeBtn();
    await renderReady({ state: ranked({ subscriber: { globalAlerts: { dews: false, depeg: false } } }), startParam: `coin_${USDT}`, launch: withMain(uMain) });
    hasT("Not in your coins yet.");
    noGrp("Snooze USDT");
    await mainIs(uMain, "Follow USDT");

    cleanup();
    const xMain = nativeBtn(), xFetch = await renderReady({ startParam: "coin_old-coin", launch: withMain(xMain) });
    expect(screen.getAllByText("Pharos no longer tracks this coin").length).toBeGreaterThan(0);
    expect([Boolean(btn("Browse coins")), xMain.isVisible, calls(xFetch)]).toEqual([true, false, 1]);
  });

  it("adds coins through one ranked multi-select, the bulk preview/confirm pair, and a snackbar undo", async () => {
    const [main, back] = [nativeBtn(), nativeBtn()], state = ranked();
    const m = seq(ok(state), preview([USDT, USD0]), ok(state), ok(state));
    await renderReady({ fetchImpl: m, launch: { MainButton: main, BackButton: back } });
    tap(L_ADD);
    setInput(searchEl(), "usd");
    const rows = () => screen.getAllByRole("checkbox").map((r) => [r.getAttribute("aria-label"), checked(r)]);
    expect(rows()).toEqual([[C_USDT, "false"], [C_FOL, "true"], [C_USD0, "false"]]);
    expect(main.isVisible).toBe(false);
    click(chk(C_USDT));
    click(chk(C_USD0));
    expect(rows()).toEqual([[`${C_USDT}, will be added`, "true"], [C_FOL, "true"], [`${C_USD0}, will be added`, "true"]]);
    expect(screen.getAllByText(/^Will be added/)).toHaveLength(2);
    await mainIs(main, L_ADD2);
    click(chk(C_FOL));
    expect(checked(chk(C_REM))).toBe("false");
    await mainIs(main, "Save 3 changes");
    click(chk(C_REM));
    await mainIs(main, L_ADD2);

    tapMain(main);
    await wf(() => hasT("Added 2 coins."));
    const sel = { addStablecoinIds: [USDT, USD0], removeStablecoinIds: [] };
    expectMut(m, { kind: "preview-bulk-watchlist", ...sel }, 2);
    expectMut(m, { kind: "confirm-bulk-watchlist", ...sel, expectedPreferenceGeneration: 1, previewFingerprint: FP }, 3);
    hasH(H_ON);

    tap("Undo");
    disabled(btn("Undo"), true);
    await waitCalls(m, 4);
    expectMut(m, { kind: "undo-bulk-watchlist", expectedPreferenceGeneration: 2, expectedFingerprint: FP, restoreDirectRows: [], removeStablecoinIds: [USDT, USD0] });
  });

  it.each(["preview", "confirm"])("reconciles snackbar Undo with a draft and retains it after a failed %s", async (failure) => {
    const main = nativeBtn(), state = ranked();
    const undo = {
      expectedPreferenceGeneration: 2, expectedFingerprint: FP, removeStablecoinIds: [],
      restoreDirectRows: [{ stablecoinId: USDC, alertDews: true, alertDepeg: true, alertSafety: false, alertLaunch: false, alertReserve: false, overrideDews: false, overrideDepeg: false, overrideSafety: false, overrideLaunch: false, overrideReserve: false, dewsMinBand: "ALERT" as const, safetyMode: null, depegWorseningBpsStep: 250 }],
    };
    const m = seq(ok(state), ok(ver({ stateRevision: "removed", state: { ...state, subscriptions: [] }, undo })), ok(state));
    await renderReady({ fetchImpl: m, startParam: C_USDC, launch: withMain(main) });
    tap("Use All stablecoins settings for USDC");
    await findT("USDC reset to All stablecoins settings.");
    tap(L_ADD);
    const search = searchEl();
    for (const [sym, name] of [["USDC", /^USDC /], ["USD0", /^USD0 /]] as const) { setInput(search, sym); click(chk(name)); }
    tap("Undo");
    setInput(search, "usd");
    const ready = (label: string, n?: number) => wf(() => { if (n != null) expect(calls(m)).toBe(n); expect([main.text, main.isActive, main.live.size]).toEqual([label, true, 1]); });
    await ready(L_ADD1, 3);
    expect(checked(chk(C_FOL))).toBe("true");
    click(chk(C_FOL));
    await ready(L_SAVE2);
    const sel = { addStablecoinIds: [USD0], removeStablecoinIds: [USDC] };
    if (failure === "confirm") m.mockResolvedValueOnce(preview(sel.addStablecoinIds, sel.removeStablecoinIds));
    m.mockResolvedValueOnce(fail(500));
    tapMain(main);
    await findT(L_CANT);
    const fc = failure === "confirm" ? 5 : 4;
    await ready(L_SAVE2, fc);
    expect([checked(chk(C_REM)), checked(chk(`${C_USD0}, will be added`))]).toEqual(["false", "true"]);
    m.mockResolvedValueOnce(preview(sel.addStablecoinIds, sel.removeStablecoinIds)).mockResolvedValueOnce(ok(state));
    tapMain(main);
    await wf(() => { expect(calls(m)).toBe(fc + 2); expectMut(m, { kind: "confirm-bulk-watchlist", ...sel, expectedPreferenceGeneration: 1, previewFingerprint: FP }, fc + 2); });
    await findT("Added 1 coin, removed 1.");
  });

  it("follows a preset from Follow a preset through the MainButton", async () => {
    const main = nativeBtn(), m = await renderReady({ state: ranked(), launch: withMain(main) });
    tap(L_PRESET);
    tap(/^USD Top 50/);
    await mainIs(main, "Follow USD Top 50");
    click(sw("USD Top 50 Safety Score"));
    tapMain(main);
    await waitMut(m, { kind: "follow-preset", presetId: "usd-top50", alertTypes: { dews: true, depeg: true, safety: true } });
  });

  it("commits quiet hours on change, disables the colliding hour, and rejects equal start and end locally", async () => {
    const m = await renderReady({ state: withSub({ quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7, timezone: "Europe/Paris" } }), startParam: "quiet-hours" });
    noBtn(/Save/);
    const from = screen.getByLabelText("From");
    disabled(within(from).getByRole("option", { name: "07:00 (same as To)" }), true);
    setInput(from, "7");
    await findT("Quiet hours need different start and end times.");
    once(m);
    setInput(from, "23");
    await waitMut(m, { kind: "set-quiet-hours", enabled: true, startHourUtc: 23, endHourUtc: 7 });
    await wf(() => disabled(sw("Quiet hours"), false));
    click(sw("Quiet hours"));
    await waitMut(m, { kind: "set-quiet-hours", enabled: false });
  });

  it("states a snooze once in the status strip, keeps inline Resume when blocked or without MainButton", async () => {
    const state = withSnooze(9_000_000_000), m = seq(ok(state), ok(baseState));
    await renderReady({ fetchImpl: m });
    hasH("Alerts paused");
    noGrp(L_PAUSE);
    click(within(grp(L_RESUME)).getByRole("button"));
    await waitMut(m, { kind: "clear-snooze" });

    cleanup();
    const main = nativeBtn();
    await renderReady({ state, launch: withMain(main) });
    await mainIs(main, L_RESUME);
    noGrp(L_RESUME);

    cleanup();
    const bMain = nativeBtn();
    await renderReady({ state: mkState({ subscriber: { snoozeUntilTs: PAUSE_SENTINEL_TS }, health: { recentFailureClass: "blocked" } }), launch: { MainButton: bMain, openTelegramLink: vi.fn() } });
    await mainIs(bMain, L_CHAT);
    expect(grp(L_RESUME)).toBeTruthy();
  });

  it.each(["blocked", "chat_not_found"])("puts the recovery action in the MainButton for %s delivery", async (failureClass) => {
    const [main, openTg] = [nativeBtn(), vi.fn()];
    await renderReady({ state: withHealth({ recentFailureClass: failureClass }), launch: { MainButton: main, openTelegramLink: openTg } });
    hasH("Telegram stopped delivering alerts");
    noH(H_ON);
    await mainIs(main, L_CHAT);
    tapMain(main);
    openWith(openTg, "start=status");
  });

  it("shows one reopen state, keeps controls tappable, never sends, and relaunches the current screen", async () => {
    const [main, openTg, impact, notif, close] = [nativeBtn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const m = await renderReady({ state: rankedStale, startParam: C_USDC, launch: { openTelegramLink: openTg, close, MainButton: main, HapticFeedback: { impactOccurred: impact, notificationOccurred: notif } } });
    expect(screen.getAllByRole("heading", { name: H_EDIT })).toHaveLength(1);
    await mainIs(main, L_REOPEN);
    const safety = sw(L_USDC_S);
    disabled(safety, false);
    click(safety);
    await findT(L_UNSAVED);
    noT("Not saved: USDC: Safety Score on.");
    expect([screen.getAllByRole("heading", { name: H_EDIT }).length, calls(m)]).toEqual([1, 1]);
    expect(notif).toHaveBeenCalledWith("warning");
    tapMain(main);
    openWith(openTg, `startapp=${C_USDC}`);
    expect(impact).toHaveBeenCalledWith("light");
    tap("Close");
    once(close);
  });

  it("keeps refreshing readable state after the 5-minute edit window and routes edits to reopen", async () => {
    freezeNow();
    const main = nativeBtn(), m = seq(ok(baseState)).mockResolvedValue(ok(staleState));
    renderMiniApp({ fetchImpl: m, launch: { MainButton: main, openTelegramLink: vi.fn() } });
    await tick(20);
    once(m);
    const vis = vi.spyOn(document, "visibilityState", "get");
    for (const n of [2, 3]) {
      act(() => { vis.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
      await tick(10 * 60 * 1000 + 1);
      act(() => { vis.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
      await tick(20);
      expect(calls(m)).toBe(n);
      hasH(H_EDIT);
    }
    tap(R_ALL);
    click(sw(L_ALL_S));
    hasT("Not saved: All stablecoins: Safety Score on. Reopen to edit.");
    expect([main.text, calls(m)]).toEqual([L_REOPEN, 3]);
  });

  it("handles stale-auth on preview reads, expired initial session reads, and mutations without retrying", async () => {
    const m1 = seq(ok(baseState), staleFail());
    await renderReady({ fetchImpl: m1 });
    tap(L_ADD);
    click(chk(C_USDT));
    tap(L_ADD1);
    await findH(L_EXP);
    hideFor(3_600_000);
    await flush();
    expect(calls(m1)).toBe(2);

    cleanup();
    const [close, openTg] = [vi.fn(), vi.fn()], m2 = seq(staleFail());
    renderMiniApp({ fetchImpl: m2, launch: { close, openTelegramLink: openTg } });
    await findH(L_EXP);
    noBtn("Try again");
    hideFor(3_600_000);
    await flush();
    once(m2);
    tap(L_REOPEN);
    openWith(openTg, "startapp=home");
    tap("Close");
    once(close);

    cleanup();
    const m3 = await renderReady({ fetchImpl: seq(ok(ranked()), staleFail()), startParam: C_USDC });
    click(sw(L_USDC_S));
    await findH(H_EDIT);
    hasT(L_UNSAVED);
    expect(checked(sw(L_USDC_S))).toBe("false");
    click(sw(L_USDC_R));
    await findT("Not saved: USDC: Reserve drift on. Reopen to edit.");
    expect(calls(m3)).toBe(2);
  });

  it("keeps last-known state read-only through a refresh failure until retry", async () => {
    const state = ranked(), m = seq(ok(state), fail(503, { error: "offline", code: "internal" }), ok(state));
    await renderReady({ fetchImpl: m, startParam: C_USDC });
    hideFor(600_001);
    await findH(L_REF);
    hasT(/Pharos is busy right now/);
    noT(/state-v1-/);
    disabled(sw(L_USDC_S), true);
    tap("Try again");
    await wf(() => noH(L_REF));
    disabled(sw(L_USDC_S), false);
    expect(calls(m)).toBe(3);
  });

  it("wires one mutation through pending to confirmed state and shows inline Refresh on ambiguous failure", async () => {
    const next = withSub({ globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } });
    const pending = deferOk(), m = await renderReady({ fetchImpl: seq(ok(baseState)).mockReturnValueOnce(pending.promise) });
    tap(R_ALL);
    const safety = sw(L_ALL_S);
    click(safety);
    await waitCalls(m, 2);
    expect([checked(safety), safety.getAttribute("aria-busy"), screen.queryByRole("switch", { name: /Launch/ })]).toEqual(["false", "true", null]);
    disabled(sw("All stablecoins Reserve drift"), true);
    pending.resolve(ok(next));
    await wf(() => expect(checked(sw(L_ALL_S))).toBe("true"));
    hasT("All stablecoins: Safety Score on.");
    expectMut(m, { kind: "set-global", alertType: "safety", enabled: true });

    cleanup();
    const m2 = seq(ok(baseState), fail(500, { error: "x", code: "internal" }), ok(baseState));
    await renderReady({ fetchImpl: m2 });
    tap(R_ALL);
    click(sw(L_ALL_S));
    await wf(() => hasT(L_CANT));
    expectMut(m2, { kind: "set-global", alertType: "safety", enabled: true }, 2);
    expect(checked(sw(L_ALL_S))).toBe("false");
    tap("Refresh");
    await waitCalls(m2, 3);
    expect(String(m2.mock.calls[2]?.[0])).toMatch(/^\/api\/telegram-mini-app\/session\?/);
    noT(L_CANT);
  });

  it("keeps same-coin sibling controls interactive while coalescing, guards cross-entity writes, and survives stale-auth repeat & 409 update", async () => {
    const [first, second] = [deferOk(), deferOk()], coinState = ranked(), usdc = coinState.subscriptions[0]!;
    const withUsdc = (on: { safety?: true; reserve?: true }) => ranked({ subscriptions: [{ ...usdc, alertTypes: { ...usdc.alertTypes, ...on }, alertOverrides: { ...ALL_OFF, dews: true, depeg: true, ...on } }] });
    const m = seq(ok(coinState)).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderReady({ fetchImpl: m, startParam: C_USDC });
    const [safety, reserve] = [sw(L_USDC_S), sw(L_USDC_R)];
    click(safety);
    expect([checked(safety), safety.getAttribute("aria-busy")]).toEqual(["false", "true"]);
    disabled(reserve, false);
    click(reserve);
    expect([checked(reserve), reserve.getAttribute("data-queued")]).toEqual(["false", "true"]);
    tap("Back");
    hasT("Saving USDC changes…");
    await act(async () => { first.resolve(ok(withUsdc({ safety: true }))); await Promise.resolve(); });
    await waitCalls(m, 3);
    expectMut(m, setCoinOp({ alertTypes: { reserve: true } }), 3);
    await act(async () => { second.resolve(ok(withUsdc({ safety: true, reserve: true }))); await Promise.resolve(); });
    await wf(() => noT("Saving USDC changes…"));

    cleanup();
    await renderReady({ state: rankedStale, startParam: C_USDC });
    expect(botHref()).toBeTruthy();
    const staleS = sw(L_USDC_S);
    click(staleS);
    await findT(L_UNSAVED);
    tap("Dismiss");
    noT(L_UNSAVED);
    click(staleS);
    await findT(L_UNSAVED);

    cleanup();
    const [main, openTg, close] = [nativeBtn(), vi.fn(), vi.fn()];
    window.sessionStorage.setItem("pharos-mini-app-version-refresh", "99:catalog-v99");
    await renderReady({ fetchImpl: seq(ok(baseState), fail(409, { error: "v", code: "contract-version-mismatch", contractVersion: "99", catalogVersion: "catalog-v99" })), launch: { MainButton: main, openTelegramLink: openTg, close } });
    tap(/^All stablecoins/);
    click(sw(L_ALL_S));
    await findH("Update required");
    await mainIs(main, "Reopen");
    tapMain(main);
    openWith(openTg, "startapp=preset_all");
    once(close);

    cleanup();
    const dMain = nativeBtn();
    const dFetch = seq(ok(coinState), fail(409, { error: "stale", code: "stale-bulk-preview" }), ok({ ...coinState, subscriptions: [usdc, { ...usdc, stablecoinId: USDT, symbol: "USDT", name: "Tether" }] }));
    await renderReady({ fetchImpl: dFetch, launch: withMain(dMain) });
    tap(L_ADD);
    click(chk(C_USDT));
    await mainIs(dMain, "Add 1 coin");
    tapMain(dMain);
    await waitCalls(dFetch, 3);
    expect(String(dFetch.mock.calls[2]?.[0])).toMatch(/^\/api\/telegram-mini-app\/session\?/);
    await wf(() => expect(checked(chk(`${C_USDT}, following`))).toBe("true"));
    expect(dMain.isVisible).toBe(false);
  });

  it.each<[string, number | null, string | null]>([
    ["future", NOW + 1, L_RESUME], ["exactly expired", NOW, null], ["unset", null, null], ["pause sentinel", PAUSE_SENTINEL_TS, L_RESUME],
  ])("uses the shared clock for %s snooze in Home and the native MainButton", async (_s, snoozeUntilTs, label) => {
    freezeNow();
    const main = nativeBtn(), m = renderMiniApp({ state: withSnooze(snoozeUntilTs), launch: withMain(main) });
    await tick(20);
    if (label != null) { expect(main.text).toBe(label); noGrp(L_PAUSE); }
    else { expect(grp(L_PAUSE)).toBeTruthy(); expect([calls(main.show), calls(main.onClick)]).toEqual([0, 0]); }
    once(m);
  });

  it("advances delivery ages and restores Pause/detaches MainButton at exact snooze expiry without a POST", async () => {
    freezeNow();
    const m = renderMiniApp({ state: withHealth({ lastSuccessfulDeliveryAt: NOW - 60, lastSuccessfulReplyAt: null }), startParam: "settings" });
    await tick(20);
    hasT("1 min ago");
    await tick(10 * 60_000);
    hasT("11 min ago");
    once(m);

    cleanup();
    vi.setSystemTime(NOW * 1000);
    const main = nativeBtn(), m2 = renderMiniApp({ state: withSnooze(NOW + 2), launch: withMain(main) });
    await tick(20);
    expect(main.text).toBe(L_RESUME);
    const attached = main.callbacks.at(-1);
    await tick(1_980);
    expect([Boolean(grp(L_PAUSE)), main.isVisible, calls(m2)]).toEqual([true, false, 1]);
    expect(main.offClick).toHaveBeenCalledWith(attached);
  });

  it.each([
    ["'Not yet' when diagnostics are available but unobserved", true, "Not yet"],
    ["an unavailable dash and explanation when diagnostics could not be read", false, "—"],
  ] as const)("shows both delivery clocks as %s", async (_c, diagnosticsAvailable, value) => {
    await renderReady({ state: withHealth({ diagnosticsAvailable, lastSuccessfulDeliveryAt: null, lastSuccessfulReplyAt: null }), startParam: "settings" });
    hasT("Delivery", "Last alert delivered", "Last reply from the bot");
    expect([screen.getAllByText(value).length, screen.queryByText("Delivery status can't be read right now.") != null]).toEqual([2, !diagnosticsAvailable]);
  });

  it("never stacks native MainButton listeners and guards duplicate clicks while a mutation is in flight", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const main = nativeBtn(), liveCounts: number[] = [];
    main.onClick.mockImplementation((cb: () => void) => { main.callbacks.push(cb); main.live.add(cb); liveCounts.push(main.live.size); });
    const m = seq(ok(newUser), ok(withSnooze(9_000_000_000)), ok(withSnooze(null)));
    await renderReady({ fetchImpl: m, launch: withMain(main) });
    await mainIs(main, `Follow ${L_TOP25}`);
    tapMain(main);
    await mainIs(main, L_RESUME);
    tapMain(main);
    await wf(() => expect([calls(m), main.live.size]).toEqual([3, 0]));
    expect([Math.max(...liveCounts), new Set(main.callbacks).size]).toEqual([1, main.callbacks.length]);

    cleanup();
    const main2 = nativeBtn(), pending = deferOk(), m2 = seq(ok(newUser)).mockReturnValueOnce(pending.promise);
    await renderReady({ fetchImpl: m2, launch: withMain(main2) });
    await mainIs(main2, `Follow ${L_TOP25}`);
    const h = main2.callbacks.at(-1)!;
    act(() => { h(); h(); });
    await waitCalls(m2, 2);
    pending.resolve(ok(baseState));
    await wf(() => hasT("Following USD Top 25: early warnings and depegs."));
    expect(calls(m2)).toBe(2);
  });

  it("supports Escape and inline Back fallback, guards SettingsButton and non-empty search Escape, and arms closing confirmation for dirty Add coins drafts", async () => {
    const [enClose, disClose, settings] = [vi.fn(), vi.fn(), nativeBtn()];
    let popupCb: ((id: string) => void) | undefined;
    const showPopup = vi.fn((_p, cb?: (id: string) => void) => { popupCb = cb; });
    await renderReady({ state: ranked(), launch: { enableClosingConfirmation: enClose, disableClosingConfirmation: disClose, SettingsButton: settings, showPopup, isVersionAtLeast: () => true } });
    tap(L_SET);
    hasH1(L_SET);
    expect(btn("Back")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    hasH1(H_ON);

    tap(L_ADD);
    const search = searchEl();
    setInput(search, "usd");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(searchEl()).toBeTruthy();
    click(chk(C_USDT));
    expect(enClose).toHaveBeenCalled();
    tapMain(settings);
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ title: "Discard 1 change?" }), expect.any(Function));
    act(() => popupCb?.("keep"));
    expect(searchEl()).toBeTruthy();
    tapMain(settings);
    act(() => popupCb?.("discard"));
    hasH1(L_SET);
    expect(disClose).toHaveBeenCalled();
  });

  it("tracks write-auth expiry via monotonic clock without a pre-expiry countdown and applies v10 bulk edits in 1 RTT", async () => {
    freezeNow();
    const main = nativeBtn();
    const mutable = mutableState({ viewer: { mutationAuthExpiresAt: NOW + 120 }, directStateProof: { preferenceGeneration: 4, directFingerprint: "direct-v1-10-deadbeef" } });
    const applied = { ...mkSnap(mutable, NOW + 90), bulkResult: { adds: [USDT], removes: [], unchanged: [], sourceImpact: [] }, undo: { expectedPreferenceGeneration: 5, expectedFingerprint: "preview-v1-5-abcdef12", restoreDirectRows: [], removeStablecoinIds: [USDT] } };
    const m = ctxFetch(mutable, () => coinsCtx([]), () => ok(applied));
    renderMiniApp({ fetchImpl: m, launch: { MainButton: main, openTelegramLink: vi.fn() } });
    await tick(20);
    hasH(H_ON);

    await tick(90_000);
    noH(H_EDIT);
    noT(/seconds? left|expir/i);

    tap(L_ADD);
    click(chk(C_USDT));
    expect(main.text).toBe(L_ADD1);
    tapMain(main);
    await tick(20);
    expect(m.mock.calls.filter(([u]) => String(u).includes("/mutate")).map(([, init]) => JSON.parse(String(init?.body)).operation)).toEqual([{ kind: "apply-bulk-watchlist", addStablecoinIds: [USDT], removeStablecoinIds: [], expectedPreferenceGeneration: 4, expectedDirectFingerprint: "direct-v1-10-deadbeef" }]);
    hasT("Added 1 coin.");

    const n = calls(m);
    await tick(35_000);
    hasH(H_EDIT);
    expect([main.text, calls(m)]).toEqual([L_REOPEN, n]);
  });

  it("renders scoped live risk context across Home, Coin, and Follow a preset slots with cache reuse and honest unavailable states", async () => {
    const coin = (stablecoinId: string, symbol: string, name: string, snoozeUntilTs: number | null) => ({ ...baseState.subscriptions[0]!, stablecoinId, symbol, name, snoozeUntilTs });
    const mutable = mutableState({ subscriptions: [coin(USDT, "USDT", "Tether", null), coin("dai-makerdao", "DAI", "Dai", 9_000_000_000), coin(USDC, "USDC", "USD Coin", null)] });
    const sig = (priceUsd: number, band: string, score: number, grade: string, safetyScore: number) => ({ price: { provenance: okProv, priceUsd }, dews: { provenance: okProv, band, score }, safety: { provenance: okProv, ratingStatus: "rated", grade, score: safetyScore, held: false, methodologyVersion: "9.0", publicationId: "p1" } });
    const coinsRes = coinsCtx([{ stablecoinId: USDC, direction: "below", peakDeviationBps: -150, currentDeviationBps: -130, priceUsd: 0.9871, pegReference: 1, startedAt: NOW - 600 }], { [USDC]: sig(0.9871, "WARNING", 68, "A-", 86), [USDT]: sig(0.9999, "CALM", 12, "B+", 78), "dai-makerdao": sig(1, "CALM", 10, "A-", 84) });
    const presetsRes = ok(ver({ context: { kind: "presets", provenance: okProv, presets: [{ id: "usd-top25", memberCount: 25, topSymbols: ["USDT", "USDC", "USDS"] }] } }));
    const ctxCalls: unknown[] = [];
    await renderReady({ fetchImpl: ctxFetch(mutable, (req) => { ctxCalls.push(req); return req.kind === "presets" ? presetsRes : coinsRes; }) });

    await findH("USDC is off its peg");
    hasH("Off peg now");
    const secOf = (name: string) => within(screen.getByRole("heading", { name }).closest("section")!);
    const coinBtns = secOf("Your coins").getAllByRole("button").map((b) => b.textContent ?? "").filter((t) => !t.startsWith("Add"));
    expect(coinBtns.map((t) => t.match(/^(USDC|DAI|USDT)/)?.[1])).toEqual(["USDC", "DAI", "USDT"]);

    click(secOf("Off peg now").getByRole("button", { name: /USDC/ }));
    await findT("$0.9871 · 1.3% below peg · DEWS Warning 68 · Safety A-");
    expect(ctxCalls).toHaveLength(1);
    noBtn(/Send status to chat/);

    tap("Back");
    tap(L_PRESET);
    await findT("25 coins: USDT, USDC, USDS and 22 more");
    expect(ctxCalls).toEqual([{ kind: "coins", stablecoinIds: expect.arrayContaining([USDC, USDT, "dai-makerdao"]) }, { kind: "presets" }]);

    cleanup();
    const unavailSig = { price: { provenance: unavailProv, priceUsd: null }, dews: { provenance: unavailProv, band: null, score: null }, safety: { provenance: unavailProv, ratingStatus: null, grade: null, score: null, held: false, methodologyVersion: null, publicationId: null } };
    await renderReady({ fetchImpl: ctxFetch(mutable, () => coinsCtx([], { [USDC]: unavailSig }, unavailProv)) });
    await findT("Live peg status unavailable.");
    tap(/^USDC/);
    await findT("Live data unavailable.");
  });

  it("retries 429 context cooldown once without infinite looping and avoids totalizing truncated Home depegs (R7)", async () => {
    freezeNow();
    const { TELEGRAM_MINI_APP_CATALOG } = await import("@shared/lib/telegram-mini-app-catalog");
    const top21 = TELEGRAM_MINI_APP_CATALOG.searchableCoins.slice(0, 21).map((c) => c.stablecoinId);
    const mutable = mutableState({ subscriptions: [], presets: [top25({ dews: true, depeg: true }, top21)] });
    const cool = () => fail(429, { error: "cool", code: "rate-limited", retryAfterSec: 1 });
    let coinsN = 0, presetsN = 0;
    renderMiniApp({
      fetchImpl: ctxFetch(mutable, (req) => {
        if (req.kind === "presets") { presetsN += 1; return cool(); }
        expect(req.kind).toBe("coins");
        if (++coinsN === 1) return cool();
        expect(req.stablecoinIds).toHaveLength(20);
        const dp = (i: number, direction: string, peakDeviationBps: number, currentDeviationBps: number, priceUsd: number, ago: number) => ({ stablecoinId: top21[i]!, direction, peakDeviationBps, currentDeviationBps, priceUsd, pegReference: 1, startedAt: NOW - ago });
        return coinsCtx([dp(0, "below", -150, -130, 0.987, 600), dp(1, "above", 120, 110, 1.011, 300)]);
      }),
    });
    await tick(20);
    expect(coinsN).toBe(1);
    noT("Live peg status unavailable.");
    await tick(1_100);
    expect(coinsN).toBe(2);
    hasH("2+ watched coins off peg");
    hasT("Checked 20 of your watched coins.");
    tap(L_PRESET);
    await tick(5_000);
    expect(presetsN).toBe(2);
  });

  it("shows non-blocking pre-launch and capability hints on CoinScreen without blocking toggles", async () => {
    const capState = (status: "pre-launch" | "active", on: boolean) => mkState({ catalog: { recommendedPresets: [], searchableCoins: [{ stablecoinId: USDC, symbol: "USDC", name: "USD Coin", peg: "USD", status, rank: 1, variant: false, yieldBearing: false, liveReserves: on, freezeTracked: on }] } });
    const hints = ["Pre-launch: alerts start once tracked live", /No live reserve feed configured/, /No issuer freeze tracking configured/] as const;
    const m = await renderReady({ state: capState("pre-launch", false), startParam: C_USDC });
    hasT(...hints);
    const [reserve, freeze] = [sw(L_USDC_R), sw("USDC Freezes")];
    disabled(reserve, false);
    disabled(freeze, false);
    click(reserve);
    await waitMut(m, setCoinOp({ alertTypes: { reserve: true } }));

    cleanup();
    await renderReady({ state: capState("active", true), startParam: C_USDC });
    noT(...hints);
  });
});

describe("Mini App confirmed watcher status", () => {
  const emptyState = mkState({ subscriber: { globalAlerts: ALL_OFF }, subscriptions: [], presets: [] });

  function launch(state: TelegramMiniAppState, next = state) {
    installMatchMediaMock();
    setTg();
    const ops: unknown[] = [];
    mockFetch([{ match: "/api/telegram-mini-app/", respond: async (r) => new URL(r.url).pathname.endsWith("/mutate") ? (ops.push((await r.json() as { operation: unknown }).operation), { body: next }) : { body: state } }], { requireMatch: true });
    render(<PharosWatchBotMiniAppClient />);
    return ops;
  }

  it.each([
    [emptyState, "Get stablecoin alerts in this chat"],
    [withSnooze(4_102_444_800), "Alerts paused"],
    [withSnooze(9_000_000_000), "Alerts paused"],
    [withHealth({ recentFailureClass: "blocked" }), "Telegram stopped delivering alerts"],
    [withHealth({ recentFailureClass: "chat_not_found" }), "Telegram stopped delivering alerts"],
    [mkState(), H_ON],
  ])("classifies the confirmed session as %#: %s", async (state, h) => {
    launch(state);
    await wf(() => hasH(h));
    if (h !== H_ON) noH(H_ON);
  });

  it.each(["bad_request", "formatting_error", "payload_too_large", "auth_error", "chat_migrated"])(
    "does not promise a retry for the non-retryable failure class %s",
    async (failureClass) => {
      launch(withHealth({ recentFailureClass: failureClass }));
      await wf(() => hasH("Last delivery failed"));
      noT(/retry automatically/i);
    },
  );

  it("stops claiming active alerts after confirmed unsubscribe-all retains the subscriber", async () => {
    const ops = launch(mkState(), emptyState);
    await wf(() => hasH(H_ON));
    tap(L_SET);
    tap(/^Unsubscribe from all alerts/);
    expect(ops).toEqual([]);
    tap(/^Tap again to unsubscribe from all/);
    await wf(() => hasT("Unsubscribed from all alerts."));
    expect(ops).toEqual([{ kind: "unsubscribe-all" }]);
    hasT("Last alert delivered");
    noBtn(/^Unsubscribe from all alerts/);
  });
});
