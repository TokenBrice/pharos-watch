// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor as wf } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { MiniAppRequestError, type MiniAppErrorCode } from "./error-messages";
import { baseState } from "@shared/test-utils/telegram-mini-app-state";
import type { TelegramMiniAppClientSnapshot } from "./mini-app-api";
import { useMiniAppMutations, type UseMiniAppMutationsArgs } from "./use-mini-app-mutations";
import type { TelegramWebAppSdk } from "./telegram-sdk";
import type { TelegramMiniAppBulkWatchlistResponse, TelegramMiniAppOperation, TelegramMiniAppState } from "./types";

const apiMocks = vi.hoisted(() => ({ postMiniAppSnapshot: vi.fn(), refreshMiniAppBundleOnce: vi.fn(), postMiniAppBulkWatchlistPreview: vi.fn() }));
vi.mock("./mini-app-api", async (orig) => ({ ...(await orig<typeof import("./mini-app-api")>()), ...apiMocks }));
const persistedMod = await vi.importActual("../../../../worker/src/telegram/mini-app/telegram-mini-app-mutations");

const { postMiniAppSnapshot: postSnap, refreshMiniAppBundleOnce: refreshBundle, postMiniAppBulkWatchlistPreview: postPreview } = apiMocks;
const INIT = "signed-init-data", USDC_ID = "usdc-circle", USDT_ID = "usdt-tether", USDC = baseState.subscriptions[0]!;
const BULK_PREVIEW = { kind: "preview-bulk-watchlist", addStablecoinIds: [USDC_ID], removeStablecoinIds: [] } as const satisfies Extract<TelegramMiniAppOperation, { kind: "preview-bulk-watchlist" }>;
const PRESET_IMPACT = [{ stablecoinId: USDC_ID, action: "remove", inheritedSourcesAfter: ["preset"] }];
const PAUSE: TelegramMiniAppOperation = { kind: "pause" }, CLEAR: TelegramMiniAppOperation = { kind: "clear-snooze" }, FORGET: TelegramMiniAppOperation = { kind: "forget-me" };

const snap = (state: TelegramMiniAppState = baseState): TelegramMiniAppClientSnapshot => ({ state, stateRevision: "state-v1-test" });
const webAppOf = (ov: Partial<TelegramWebAppSdk> = {}): TelegramWebAppSdk => ({ initData: INIT, enableClosingConfirmation: vi.fn(), disableClosingConfirmation: vi.fn(), HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn() }, ...ov });
const makeArgs = (ov: Partial<UseMiniAppMutationsArgs> = {}): UseMiniAppMutationsArgs => ({ initData: INIT, state: baseState, webApp: webAppOf(), onSnapshotReplaced: vi.fn(), onForgotten: vi.fn(), authExpired: false, onSessionAuthExpired: vi.fn(), mutationsAllowed: true, signedReadsAllowed: true, ...ov });
const mount = (ov: Partial<UseMiniAppMutationsArgs> = {}) => renderHook(() => useMiniAppMutations(makeArgs(ov))).result;
const mountProps = (args: UseMiniAppMutationsArgs) => renderHook((p) => useMiniAppMutations(p), { initialProps: args });
const confirmWith = (c: boolean) => vi.fn((_m: string, cb: (ok: boolean) => void) => cb(c));
const calls = (m: { mock: { calls: unknown[] } }) => m.mock.calls.length;
const sentOps = (): TelegramMiniAppOperation[] => postSnap.mock.calls.map((c) => c[1].operation);
const setCoin = (patch: Record<string, unknown>, stablecoinId = USDC_ID) => ({ kind: "set-coin", stablecoinId, patch } as TelegramMiniAppOperation);
const at = (alertTypes: Record<string, boolean>, stablecoinId = USDC_ID) => setCoin({ alertTypes }, stablecoinId);
const bulkUndo = (g: number, removeStablecoinIds: string[]) => ({ expectedPreferenceGeneration: g, expectedFingerprint: `preview-v1-${g}-abcdef12`, restoreDirectRows: [], removeStablecoinIds });
const overridesOf = (p: Record<string, boolean> = {}) => ({ dews: true, depeg: true, safety: false, launch: false, reserve: false, freeze: false, ...p });
const viewerState = (viewer: Partial<TelegramMiniAppState["viewer"]>): TelegramMiniAppState => ({ ...baseState, viewer: { ...baseState.viewer, ...viewer } });
const defer = () => Promise.withResolvers<TelegramMiniAppClientSnapshot>();
const doAct = (fn: () => unknown) => act(async () => { await fn(); });
const reqErr = (status: number, code: MiniAppErrorCode, retry?: number | null, extra?: { contractVersion?: string; catalogVersion?: string }) => new MiniAppRequestError(status, code, retry, extra);
type HookRes = ReturnType<typeof mount>;
const runMut = (r: HookRes, op: TelegramMiniAppOperation) => doAct(() => r.current.performMutation(op));
const runPrev = (r: HookRes) => doAct(() => r.current.performBulkWatchlistPreview(BULK_PREVIEW));
const runUndo = (r: HookRes) => doAct(() => r.current.undo());
const runRemove = (r: HookRes) => doAct(() => r.current.remove(USDC));
const runBulk = (r: HookRes, add: string[], rem: string[], exp = true) => doAct(async () => { expect(await r.current.applyBulkWatchlist(add, rem)).toBe(exp); });
const match = (a: unknown, b: object) => expect(a).toMatchObject(b);

const dbs: DatabaseSync[] = [];
async function persisted() {
  const { db, sqlite } = createLatestSchemaSqlite();
  dbs.push(sqlite);
  const now = Math.floor(Date.now() / 1000);
  const auth = { userId: "42", username: "alice", firstName: "Alice", chatType: "private", startParam: null, authDate: now, initDataHash: "test", canMutatePrivateChat: true } as const;
  const { applyTelegramMiniAppMutation } = persistedMod as { applyTelegramMiniAppMutation: (d: typeof db, c: typeof auth, op: TelegramMiniAppOperation, o?: { botToken?: string }) => Promise<TelegramMiniAppClientSnapshot["undo"] | void> };
  sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', ?, ?)").run(now, now);
  sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_dews_override, alert_depeg_override, alert_safety_override, dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts) VALUES ('42', 'usdc-circle', 1, 1, 0, 1, 1, 1, 'DANGER', 'downgrade-only', 250, ?)").run(now + 14_400);
  const row = () => sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42' AND stablecoin_id = 'usdc-circle'").get();
  postSnap.mockImplementation(async (_p: string, { operation }: { operation: TelegramMiniAppOperation }) => {
    try {
      const undo = await applyTelegramMiniAppMutation(db, auth, operation, { botToken: "test-bot-token" });
      return { ...snap({ ...baseState, subscriptions: row() ? baseState.subscriptions : [] }), ...(undo ? { undo } : {}) };
    } catch (e) {
      if (e instanceof Error && "code" in e) throw reqErr(409, e.code as MiniAppErrorCode);
      throw e;
    }
  });
  return { db, sqlite, auth, row, apply: applyTelegramMiniAppMutation };
}

afterEach(() => { cleanup(); while (dbs.length > 0) dbs.pop()?.close(); vi.useRealTimers(); postSnap.mockReset(); refreshBundle.mockReset(); postPreview.mockReset(); });

describe("useMiniAppMutations", () => {
  it("revokes captured mutation and signed-read callbacks after persisted forget-me", async () => {
    const { sqlite } = await persisted(), onForgotten = vi.fn(), r = mount({ onForgotten });
    const [capMut, capRead] = [r.current.performMutation, r.current.performBulkWatchlistPreview];
    await runMut(r, FORGET);
    expect([calls(onForgotten), r.current.forgottenView]).toEqual([1, true]);
    await doAct(async () => { expect([await capMut(CLEAR), await capRead(BULK_PREVIEW)]).toEqual([null, null]); });
    expect([calls(postSnap), calls(postPreview)]).toEqual([1, 0]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscribers").get()).toMatchObject({ count: 0 });
  });

  it("never dispatches writes without signed data, session permission, or viewer permission", async () => {
    for (const ov of [{ initData: "" }, { mutationsAllowed: false }, { state: viewerState({ canMutate: false }) }]) {
      const { result, unmount } = renderHook(() => useMiniAppMutations(makeArgs(ov)));
      await doAct(async () => { expect(await result.current.performMutation(PAUSE)).toBeNull(); });
      expect(result.current.isMutating).toBe(false);
      unmount();
    }
    expect(postSnap).not.toHaveBeenCalled();
  });

  it("allows a signed bulk preview in read-only mode but requires private chat identity", async () => {
    const previewed = { contractVersion: "8", catalogVersion: "catalog-v1" } as TelegramMiniAppBulkWatchlistResponse;
    postPreview.mockResolvedValue(previewed);
    const args = makeArgs({ mutationsAllowed: false, state: viewerState({ canMutate: false }) }), { result: r, rerender } = mountProps(args);
    await doAct(async () => { expect(await r.current.performBulkWatchlistPreview(BULK_PREVIEW)).toEqual(previewed); });
    expect(postPreview).toHaveBeenCalledWith(expect.any(String), { initData: INIT, operation: BULK_PREVIEW });
    rerender({ ...args, state: viewerState({ chatId: null }) });
    await doAct(async () => { expect(await r.current.performBulkWatchlistPreview(BULK_PREVIEW)).toBeNull(); });
    expect([calls(postPreview), calls(args.onSnapshotReplaced as ReturnType<typeof vi.fn>)]).toEqual([1, 0]);
  });

  it("clears a failed pending signed read without replacing confirmed state", async () => {
    const { promise, reject } = Promise.withResolvers<TelegramMiniAppBulkWatchlistResponse>();
    postPreview.mockReturnValue(promise);
    const args = makeArgs(), { result: r } = renderHook(() => useMiniAppMutations(args));
    let read!: Promise<TelegramMiniAppBulkWatchlistResponse | null>;
    act(() => { read = r.current.performBulkWatchlistPreview(BULK_PREVIEW); });
    expect([r.current.isMutating, r.current.pendingOperation]).toEqual([true, BULK_PREVIEW]);
    await doAct(async () => { reject(new Error("offline")); expect(await read).toBeNull(); });
    expect([r.current.isMutating, r.current.pendingOperation, r.current.notice?.tone]).toEqual([false, null, "error"]);
    expect(args.onSnapshotReplaced).not.toHaveBeenCalled();
  });

  it("invalidates a remove undo when unsubscribing all", async () => {
    await persisted();
    const r = mount({ webApp: webAppOf({ showConfirm: confirmWith(true) }) });
    await runRemove(r);
    expect(r.current.notice).toMatchObject({ text: "USDC removed.", undoLabel: "Undo" });
    await doAct(() => r.current.unsubscribeAll());
    expect(r.current.notice?.undoLabel).toBeUndefined();
    await runUndo(r);
    expect(sentOps().map((o) => o.kind)).toEqual(["remove-coin", "unsubscribe-all"]);
  });

  it("locks mutation state until the returned server snapshot replaces the owner state", async () => {
    const next: TelegramMiniAppState = { ...baseState, subscriber: { ...baseState.subscriber, globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } } };
    const p = defer(), onSnapshotReplaced = vi.fn(), r = mount({ onSnapshotReplaced });
    postSnap.mockReturnValueOnce(p.promise);
    const op: TelegramMiniAppOperation = { kind: "set-global", alertType: "safety", enabled: true };
    let mut!: Promise<TelegramMiniAppClientSnapshot | null>;
    act(() => { mut = r.current.performMutation(op); });
    expect([r.current.isMutating, r.current.pendingOperation, calls(onSnapshotReplaced)]).toEqual([true, op, 0]);
    p.resolve(snap(next));
    await doAct(() => mut);
    expect(onSnapshotReplaced).toHaveBeenCalledWith(snap(next));
    expect(r.current.isMutating).toBe(false);
  });

  it("enforces the server retry window and allows a mutation after it expires", async () => {
    vi.useFakeTimers();
    postSnap.mockRejectedValueOnce(reqErr(429, "rate-limited", 3));
    const r = mount();
    await runMut(r, PAUSE);
    expect([r.current.mutationRetryAfterSec, r.current.announcement, r.current.notice]).toEqual([3, "Pharos edit limit reached. Settings are disabled for 3 seconds.", null]);
    await doAct(async () => { expect(await r.current.performMutation(PAUSE)).toBeNull(); });
    expect(calls(postSnap)).toBe(1);
    for (let s = 0; s < 3; s += 1) await doAct(() => { vi.advanceTimersByTime(1_000); });
    expect([r.current.mutationRetryAfterSec, r.current.announcement]).toEqual([0, "Pharos editing is available again."]);
    postSnap.mockResolvedValueOnce(snap());
    await runMut(r, PAUSE);
    expect(calls(postSnap)).toBe(2);
  });

  it("handles 409 version mismatch silently when reload starts and enters terminal update-required otherwise", async () => {
    const err = reqErr(409, "catalog-version-mismatch", null, { contractVersion: "3", catalogVersion: "catalog-v3-next" }), webApp = webAppOf();
    refreshBundle.mockReturnValueOnce(true);
    postSnap.mockRejectedValueOnce(err);
    const rel = mount({ webApp });
    await runMut(rel, PAUSE);
    expect(refreshBundle).toHaveBeenCalledWith({ contractVersion: "3", catalogVersion: "catalog-v3-next" });
    expect([rel.current.notice, rel.current.updateRequired]).toEqual([null, false]);
    expect(webApp.HapticFeedback?.notificationOccurred).not.toHaveBeenCalled();

    const onUpdateRequired = vi.fn();
    refreshBundle.mockReturnValueOnce(false);
    postSnap.mockRejectedValueOnce(err);
    const r = mount({ onUpdateRequired });
    await runMut(r, PAUSE);
    expect([calls(onUpdateRequired), r.current.updateRequired, r.current.notice]).toEqual([1, true, null]);
    await doAct(async () => { expect(await r.current.performMutation(CLEAR)).toBeNull(); });
    expect(calls(postSnap)).toBe(2);
  });

  it("keeps a stale-auth rejection as visible intent with monotonic IDs and stops sending edits", async () => {
    postSnap.mockRejectedValueOnce(reqErr(401, "stale-auth"));
    const onSnapshotReplaced = vi.fn(), r = mount({ onSnapshotReplaced });
    await runMut(r, PAUSE);
    expect([calls(onSnapshotReplaced), r.current.notice, r.current.staleAuth]).toEqual([0, null, { id: 1, intent: "Not saved: Alerts paused until you resume." }]);
    await runMut(r, PAUSE);
    expect([calls(postSnap), r.current.staleAuth]).toEqual([1, { id: 2, intent: "Not saved: Alerts paused until you resume." }]);
  });

  it("ends the session on stale-auth signed read and never sends edits when launch auth is expired", async () => {
    postPreview.mockRejectedValueOnce(reqErr(401, "stale-auth"));
    const onSessionAuthExpired = vi.fn(), r = mount({ onSessionAuthExpired });
    await runPrev(r);
    expect([calls(onSessionAuthExpired), r.current.notice]).toEqual([1, null]);
    expect(r.current.staleAuth).toMatchObject({ intent: null });

    const exp = mount({ authExpired: true, mutationsAllowed: false });
    await runMut(exp, FORGET);
    expect(postSnap).not.toHaveBeenCalled();
    expect(exp.current.staleAuth).toMatchObject({ intent: "Data deletion was not run." });
  });

  it("restores the persisted server row, not stale client tuning, during the undo window", async () => {
    const { row } = await persisted(), before = row(), r = mount();
    await runRemove(r);
    expect([row(), r.current.notice?.undoLabel]).toEqual([undefined, "Undo"]);
    await runUndo(r);
    await wf(() => expect(r.current.isMutating).toBe(false));
    expect(row()).toEqual(before);
    expect(r.current.notice).toMatchObject({ text: "Change undone." });
  });

  it("refuses stale undo after another preference edit without retrying or overwriting it", async () => {
    const { db, auth, row, apply } = await persisted(), r = mount();
    await runRemove(r);
    expect(r.current.notice?.undoLabel).toBe("Undo");
    await apply(db, auth, setCoin({ alertTypes: { safety: true }, safetyMode: "upgrade-only" }));
    const concurrent = row();
    await runUndo(r);
    await wf(() => expect(r.current.isMutating).toBe(false));
    expect(row()).toEqual(concurrent);
    expect(r.current.notice).toMatchObject({ tone: "error" });
    await runUndo(r);
    expect(calls(postSnap)).toBe(2);
  });

  it("does not dispatch a canceled remove confirmation and warns when resetting a preset-covered coin", async () => {
    const showConfirm = confirmWith(false), r = mount({ webApp: webAppOf({ showConfirm }) });
    let rem!: Promise<boolean>;
    act(() => { rem = r.current.remove(USDC); });
    expect(showConfirm).toHaveBeenCalledWith("Remove USDC from your coins?", expect.any(Function));
    await expect(rem).resolves.toBe(false);
    act(() => { rem = r.current.remove(USDC, "USD Top 25"); });
    expect(showConfirm).toHaveBeenLastCalledWith("USDC goes back to USD Top 25 alerts. Your changes for USDC are removed.", expect.any(Function));
    await expect(rem).resolves.toBe(false);
    expect(postSnap).not.toHaveBeenCalled();
  });

  it("expires the remove undo affordance after eight seconds and emits one deduplicated notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { row } = await persisted(), r = mount({ webApp: webAppOf({ showConfirm: confirmWith(true) }) });
    act(() => { void r.current.remove(USDC); });
    await wf(() => expect(r.current.notice?.undoLabel).toBe("Undo"));
    expect(r.current.notice?.id).toBe(1);
    await doAct(() => { vi.advanceTimersByTime(5_001); });
    expect(r.current.notice?.undoLabel).toBe("Undo");
    await doAct(() => { vi.advanceTimersByTime(3_000); });
    expect(r.current.notice?.undoLabel).toBeUndefined();
    await runUndo(r);
    expect([row(), calls(postSnap)]).toEqual([undefined, 1]);
  });

  it("keeps native two-step confirmation and forget-me terminal state in the hook", async () => {
    const cbs: Array<(c: boolean) => void> = [];
    const showConfirm = vi.fn((_m: string, cb: (c: boolean) => void) => { cbs.push(cb); });
    postSnap.mockResolvedValue(snap());
    const r = mount({ webApp: webAppOf({ showConfirm }) });
    const preset = { id: "usd-top25" as const, label: "USD Top 25", alertTypes: { dews: true, depeg: true, safety: false }, depegStepBps: 250 as const };

    act(() => { r.current.unsubscribeAll(); });
    expect(calls(showConfirm)).toBe(1);
    act(() => { cbs.shift()?.(true); });
    await wf(() => expect(calls(postSnap)).toBe(1));
    act(() => { void r.current.unfollowPreset(preset); });
    expect(calls(showConfirm)).toBe(2);
    act(() => { cbs.shift()?.(true); });
    await wf(() => expect(calls(postSnap)).toBe(2));
    act(() => { r.current.forgetMe(); });
    expect(calls(showConfirm)).toBe(3);
    act(() => { cbs.shift()?.(true); });
    await wf(() => expect(calls(showConfirm)).toBe(4));
    act(() => { cbs.shift()?.(true); });
    await wf(() => expect(calls(postSnap)).toBe(3));

    expect(showConfirm.mock.calls.map(([m]) => m)).toEqual([
      "Unsubscribe from all alerts? This clears every coin, preset, and All stablecoins setting.",
      "Unfollow USD Top 25? Coins you added yourself stay as they are.",
      "Delete all your Pharos alert data? This cannot be undone.",
      "Are you absolutely sure? Your alerts and settings will be deleted.",
    ]);
    expect(postSnap.mock.calls.map(([, b]) => b)).toEqual([
      { initData: INIT, operation: { kind: "unsubscribe-all" } },
      { initData: INIT, operation: { kind: "unfollow-preset", presetId: "usd-top25" } },
      { initData: INIT, operation: FORGET },
    ]);
    await wf(() => expect(r.current.forgottenView).toBe(true));
  });

  it("uses a single native destructive showPopup for forget-me when available", async () => {
    const showPopup = vi.fn((_p, cb?: (id: string) => void) => cb?.("delete"));
    postSnap.mockResolvedValue(snap());
    const r = mount({ webApp: webAppOf({ showPopup, isVersionAtLeast: () => true }) });
    act(() => { r.current.forgetMe(); });
    await wf(() => expect(r.current.forgottenView).toBe(true));
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete all my data?", buttons: expect.arrayContaining([expect.objectContaining({ id: "delete", type: "destructive" })]) }), expect.any(Function));
    expect(postSnap).toHaveBeenCalledWith(expect.any(String), { initData: INIT, operation: FORGET });
  });

  function mockBulk(res: { adds: string[]; removes: string[]; unchanged: string[]; sourceImpact: unknown[] }) {
    postPreview.mockResolvedValue({ contractVersion: "9", catalogVersion: "c", result: { kind: "bulk-watchlist-preview", expectedPreferenceGeneration: 2, previewFingerprint: "preview-v1-2-abcdef12", ...res, undo: bulkUndo(3, [USDT_ID]) } });
    postSnap.mockResolvedValue(snap());
  }

  it("previews then confirms a bulk edit, surfaces sourceImpact, and arms the server-derived undo", async () => {
    mockBulk({ adds: [USDT_ID], removes: [USDC_ID], unchanged: [], sourceImpact: PRESET_IMPACT });
    const r = mount();
    await runBulk(r, [USDT_ID], [USDC_ID]);
    expect(sentOps()[0]).toEqual({ kind: "confirm-bulk-watchlist", addStablecoinIds: [USDT_ID], removeStablecoinIds: [USDC_ID], expectedPreferenceGeneration: 2, previewFingerprint: "preview-v1-2-abcdef12" });
    match(r.current.notice, { id: 1, text: "Added 1 coin, removed 1. USDC is still covered by a preset.", undoLabel: "Undo" });
    await runUndo(r);
    expect(sentOps()[1]).toEqual({ kind: "undo-bulk-watchlist", ...bulkUndo(3, [USDT_ID]) });
  });

  it("reports the preview's applied adds and removes, not the requested selection", async () => {
    mockBulk({ adds: [USDT_ID], removes: [], unchanged: [USDC_ID], sourceImpact: [] });
    const r = mount();
    await runBulk(r, [USDC_ID, USDT_ID], []);
    expect([calls(postSnap), sentOps()[0]]).toEqual([1, expect.objectContaining({ kind: "confirm-bulk-watchlist", addStablecoinIds: [USDC_ID, USDT_ID], removeStablecoinIds: [] })]);
    match(r.current.notice, { text: "Added 1 coin.", undoLabel: "Undo" });
  });

  it("applies a bulk edit in a single RTT with directStateProof and arms the server-derived undo", async () => {
    const undo = bulkUndo(5, [USDT_ID]);
    postSnap.mockResolvedValueOnce({ ...snap(), bulkResult: { adds: [USDT_ID], removes: [USDC_ID], unchanged: [], sourceImpact: PRESET_IMPACT }, undo }).mockResolvedValueOnce(snap());
    const r = mount({ state: { ...baseState, directStateProof: { preferenceGeneration: 4, directFingerprint: "direct-v1-10-deadbeef" } } });
    await runBulk(r, [USDT_ID], [USDC_ID]);
    expect(postPreview).not.toHaveBeenCalled();
    expect(sentOps()).toEqual([{ kind: "apply-bulk-watchlist", addStablecoinIds: [USDT_ID], removeStablecoinIds: [USDC_ID], expectedPreferenceGeneration: 4, expectedDirectFingerprint: "direct-v1-10-deadbeef" }]);
    match(r.current.notice, { text: "Added 1 coin, removed 1. USDC is still covered by a preset.", undoLabel: "Undo" });
    await runUndo(r);
    expect(sentOps()[1]).toEqual({ kind: "undo-bulk-watchlist", ...undo });
  });

  it("keeps a bulk edit as unsaved intent once launch auth expired, without a preview read", async () => {
    const r = mount({ authExpired: true });
    await runBulk(r, [USDT_ID, USDC_ID], [], false);
    expect([calls(postPreview), calls(postSnap)]).toEqual([0, 0]);
    match(r.current.staleAuth, { intent: "Not saved: Added 2 coins." });
  });

  it("tells the user a second edit was not sent while one is still saving", async () => {
    const p = defer(), r = mount();
    postSnap.mockReturnValueOnce(p.promise);
    let first!: Promise<TelegramMiniAppClientSnapshot | null>;
    act(() => { first = r.current.performMutation(PAUSE); });
    await doAct(async () => { expect(await r.current.performMutation(CLEAR)).toBeNull(); });
    expect(r.current.notice).toMatchObject({ tone: "error", text: "Still saving your last change. Try again in a moment." });
    expect(postSnap).toHaveBeenCalledOnce();
    await doAct(async () => { p.resolve(snap()); await first; });
  });

  it("keeps the undo armed while another request is in flight and clears it on revision drift", async () => {
    await persisted();
    const args = makeArgs({ stateRevision: "state-v1-test" }), { result: r, rerender } = mountProps(args);
    await runRemove(r);
    expect(r.current.notice?.undoLabel).toBe("Undo");
    const p = defer(), realImpl = postSnap.getMockImplementation()!;
    postSnap.mockImplementationOnce(() => p.promise);
    let busy!: Promise<TelegramMiniAppClientSnapshot | null>;
    act(() => { busy = r.current.performMutation(PAUSE); });
    act(() => { r.current.undo(); });
    expect([calls(postSnap), r.current.notice?.undoLabel]).toEqual([2, "Undo"]);
    await doAct(async () => { p.resolve(snap()); await busy; });
    postSnap.mockImplementation(realImpl);
    expect(sentOps().map((o) => o.kind)).toEqual(["remove-coin", "pause"]);
    postSnap.mockResolvedValueOnce({ ...snap(), undo: bulkUndo(3, [USDC_ID]) });
    await runRemove(r);
    expect(r.current.notice?.undoLabel).toBe("Undo");
    rerender({ ...args, stateRevision: "state-v1-external" });
    expect(r.current.notice?.undoLabel).toBeUndefined();
  });

  it.each<[string, TelegramMiniAppOperation, TelegramMiniAppOperation[], TelegramMiniAppState, TelegramMiniAppOperation | null]>([
    ["depeg 250 bps in flight then off + on resets depegStepBps to null", setCoin({ depegStepBps: 250 }), [at({ depeg: false }), at({ depeg: true })], { ...baseState, subscriptions: [{ ...USDC, alertOverrides: overridesOf(), depegStepBps: 250 }] }, setCoin({ alertTypes: { depeg: true }, depegStepBps: null })],
    ["folds sibling coin edits + reserve alias into one residual compound patch", at({ safety: true }), [setCoin({ reserve: true }), at({ freeze: true })], { ...baseState, subscriptions: [{ ...USDC, alertTypes: { ...USDC.alertTypes, safety: true } }] }, at({ reserve: true, freeze: true })],
    ["triple-tap already satisfied by in-flight response skips second write", at({ safety: true }), [at({ safety: false }), at({ safety: true })], { ...baseState, subscriptions: [{ ...USDC, alertTypes: { ...USDC.alertTypes, safety: true }, alertOverrides: overridesOf({ safety: true }), safetyMode: null }] }, null],
    ["follow-preset merges by field presence without reconstructing untouched booleans", { kind: "follow-preset", presetId: "usd-top25", alertTypes: { safety: true } }, [{ kind: "follow-preset", presetId: "usd-top25", alertTypes: { dews: false } }], { ...baseState, presets: [{ id: "usd-top25", label: "USD Top 25", alertTypes: { dews: true, depeg: true, safety: true }, depegStepBps: null, memberIds: [USDC_ID] }] }, { kind: "follow-preset", presetId: "usd-top25", alertTypes: { dews: false } }],
  ])("coalesces same-entity writes: %s", async (_n, firstOp, queuedOps, firstState, expected) => {
    const [first, second] = [defer(), defer()], r = mount();
    postSnap.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    act(() => { r.current.mutate(firstOp); for (const op of queuedOps) r.current.mutate(op); });
    expect([calls(postSnap), r.current.queuedOperation !== null]).toEqual([1, true]);
    await doAct(async () => { first.resolve(snap(firstState)); await Promise.resolve(); });
    if (expected == null) expect([calls(postSnap), r.current.isMutating]).toEqual([1, false]);
    else {
      await wf(() => expect(calls(postSnap)).toBe(2));
      expect(sentOps()[1]).toEqual(expected);
      await doAct(async () => { second.resolve(snap(firstState)); await Promise.resolve(); });
      expect(r.current.isMutating).toBe(false);
    }
  });

  it("discards queued edits on error, epoch change, and blocks cross-entity writes; handles 429 & drift on reads", async () => {
    const [onRefreshSession, onSnapshotReplaced, first] = [vi.fn(), vi.fn(), defer()];
    postSnap.mockReturnValueOnce(first.promise);
    const args = makeArgs({ onRefreshSession, onSnapshotReplaced }), { result: r, rerender } = mountProps(args);
    const queuePair = (target: HookRes) => act(() => { target.current.mutate(at({ safety: true })); target.current.mutate(at({ reserve: true })); });
    act(() => { r.current.mutate(at({ safety: true })); r.current.mutate(at({ reserve: true })); r.current.mutate(at({ safety: true }, USDT_ID)); });
    expect(r.current.queuedOperation).toMatchObject({ kind: "set-coin", stablecoinId: USDC_ID });
    await doAct(async () => { first.reject(reqErr(500, "internal")); await Promise.resolve(); });
    expect([calls(postSnap), r.current.queuedOperation]).toEqual([1, null]);
    expect(r.current.notice).toMatchObject({ tone: "error", text: "Couldn't confirm this change.", refreshAction: true });

    const late = defer();
    postSnap.mockReturnValueOnce(late.promise);
    queuePair(r);
    rerender({ ...args, initData: "new-launch-init-data" });
    await doAct(async () => { late.resolve(snap()); await Promise.resolve(); });
    expect([calls(onSnapshotReplaced), calls(postSnap)]).toEqual([0, 2]);

    postPreview.mockRejectedValueOnce(reqErr(429, "rate-limited", 4));
    await runPrev(r);
    expect(r.current.mutationRetryAfterSec).toBe(4);
    postPreview.mockRejectedValueOnce(reqErr(409, "stale-bulk-preview"));
    await runPrev(r);
    expect(onRefreshSession).toHaveBeenCalledOnce();

    const exp = defer(), expArgs = makeArgs(), { result: expR, rerender: rerenderExp } = mountProps(expArgs);
    postSnap.mockReturnValueOnce(exp.promise);
    queuePair(expR);
    rerenderExp({ ...expArgs, authExpired: true });
    expect(expR.current.queuedOperation).toBeNull();
    expect(expR.current.staleAuth).toMatchObject({ intent: "Not saved: USDC: Reserve drift on." });
    await doAct(async () => { exp.resolve(snap()); await Promise.resolve(); });
  });
});
