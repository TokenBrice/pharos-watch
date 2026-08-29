// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECOMMENDED_OPERATION } from "./constants";
import { MiniAppRequestError, type MiniAppErrorCode } from "./error-messages";
import { baseState } from "./mini-app-test-fixtures";
import type { TelegramMiniAppClientSnapshot } from "./mini-app-api";
import {
  useMiniAppMutations,
  type UseMiniAppMutationsArgs,
} from "./use-mini-app-mutations";
import type { TelegramWebAppSdk } from "./telegram-sdk";
import type { TelegramMiniAppOperation, TelegramMiniAppState } from "./types";

const apiMocks = vi.hoisted(() => ({
  postMiniAppSnapshot: vi.fn(),
  refreshMiniAppBundleOnce: vi.fn(),
}));

vi.mock("./mini-app-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mini-app-api")>()),
  postMiniAppSnapshot: apiMocks.postMiniAppSnapshot,
  refreshMiniAppBundleOnce: apiMocks.refreshMiniAppBundleOnce,
}));

function makeSnapshot(state: TelegramMiniAppState = baseState): TelegramMiniAppClientSnapshot {
  return { state, stateRevision: "state-v1-test" };
}

function makeWebApp(overrides: Partial<TelegramWebAppSdk> = {}): TelegramWebAppSdk {
  return {
    initData: "signed-init-data",
    enableClosingConfirmation: vi.fn(),
    disableClosingConfirmation: vi.fn(),
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn() },
    ...overrides,
  };
}

function makeArgs(overrides: Partial<UseMiniAppMutationsArgs> = {}): UseMiniAppMutationsArgs {
  return {
    initData: "signed-init-data",
    state: baseState,
    webApp: makeWebApp(),
    onSnapshotReplaced: vi.fn(),
    reloadSession: vi.fn().mockResolvedValue(undefined),
    messageAutoDismissActive: true,
    mutationsAllowed: true,
    portabilityReadsAllowed: true,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  apiMocks.postMiniAppSnapshot.mockReset();
  apiMocks.refreshMiniAppBundleOnce.mockReset();
});

describe("useMiniAppMutations", () => {
  it("locks mutation state until the returned server snapshot replaces the owner state", async () => {
    const nextState: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, globalAlerts: { ...baseState.subscriber.globalAlerts, safety: true } },
    };
    let resolveMutation!: (snapshot: TelegramMiniAppClientSnapshot) => void;
    const pendingResponse = new Promise<TelegramMiniAppClientSnapshot>((resolve) => { resolveMutation = resolve; });
    apiMocks.postMiniAppSnapshot.mockReturnValueOnce(pendingResponse);
    const onSnapshotReplaced = vi.fn();
    const webApp = makeWebApp();
    const args = makeArgs({ onSnapshotReplaced, webApp });
    const { result } = renderHook(() => useMiniAppMutations(args));
    const operation: TelegramMiniAppOperation = { kind: "set-global", alertType: "safety", enabled: true };
    let mutation!: Promise<TelegramMiniAppClientSnapshot | null>;

    act(() => { mutation = result.current.performMutation(operation); });
    expect(result.current.isMutating).toBe(true);
    expect(result.current.pendingOperation).toEqual(operation);
    expect(onSnapshotReplaced).not.toHaveBeenCalled();

    resolveMutation(makeSnapshot(nextState));
    await act(async () => { await mutation; });
    expect(onSnapshotReplaced).toHaveBeenCalledWith(makeSnapshot(nextState));
    expect(result.current.isMutating).toBe(false);
    expect(webApp.enableClosingConfirmation).toHaveBeenCalledOnce();
    expect(webApp.disableClosingConfirmation).toHaveBeenCalledOnce();
  });

  it("enforces the server retry window and allows a mutation after it expires", async () => {
    vi.useFakeTimers();
    const operation: TelegramMiniAppOperation = { kind: "pause" };
    apiMocks.postMiniAppSnapshot.mockRejectedValueOnce(new MiniAppRequestError(429, "rate-limited", 3));
    const { result } = renderHook(() => useMiniAppMutations(makeArgs()));

    await act(async () => { await result.current.performMutation(operation); });
    expect(result.current.mutationRetryAfterSec).toBe(3);
    expect(result.current.announcement).toBe("Pharos edit limit reached. Settings are disabled for 3 seconds.");
    expect(result.current.message).toBeNull();

    await act(async () => { expect(await result.current.performMutation(operation)).toBeNull(); });
    expect(apiMocks.postMiniAppSnapshot).toHaveBeenCalledOnce();

    for (let second = 0; second < 3; second += 1) {
      await act(async () => { vi.advanceTimersByTime(1_000); });
    }
    expect(result.current.mutationRetryAfterSec).toBe(0);
    expect(result.current.announcement).toBe("Pharos editing is available again.");

    apiMocks.postMiniAppSnapshot.mockResolvedValueOnce(makeSnapshot());
    await act(async () => { await result.current.performMutation(operation); });
    expect(apiMocks.postMiniAppSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes once for a version mismatch and never replays the rejected mutation", async () => {
    const error = new MiniAppRequestError(409, "catalog-version-mismatch", null, {
      contractVersion: "3",
      catalogVersion: "catalog-v2-next",
    });
    apiMocks.postMiniAppSnapshot.mockRejectedValueOnce(error);
    const { result } = renderHook(() => useMiniAppMutations(makeArgs()));

    await act(async () => { await result.current.performMutation({ kind: "pause" }); });
    expect(apiMocks.refreshMiniAppBundleOnce).toHaveBeenCalledWith({ contractVersion: "3", catalogVersion: "catalog-v2-next" });
    expect(apiMocks.postMiniAppSnapshot).toHaveBeenCalledOnce();
    expect(result.current.message).toBe("Mini App was updated. Close and reopen it from PharosWatchBot.");
  });

  it("reloads the session after stale auth without replacing the rejected snapshot", async () => {
    apiMocks.postMiniAppSnapshot.mockRejectedValueOnce(new MiniAppRequestError(401, "stale-auth"));
    const onSnapshotReplaced = vi.fn();
    const reloadSession = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useMiniAppMutations(makeArgs({ onSnapshotReplaced, reloadSession })));

    await act(async () => { await result.current.performMutation({ kind: "pause" }); });
    expect(onSnapshotReplaced).not.toHaveBeenCalled();
    expect(reloadSession).toHaveBeenCalledWith({ clearMessage: false });
    expect(result.current.message).toBe("Telegram authorization expired. Close and reopen from PharosWatchBot.");
  });

  it.each([
    [403, "not-private", "This Mini App can only edit personal alerts. Use the bot commands in groups."],
    [400, "validation-error", "Change was rejected by the server."],
    [400, "unknown-coin", "Change was rejected by the server."],
    [400, "invalid-timezone", "Change was rejected by the server."],
    [413, "body-too-large", "Request was too large to send."],
    [503, "preset-unavailable", "Mini App backend is temporarily unavailable. Try again shortly."],
    [503, "not-configured", "Mini App backend is temporarily unavailable. Try again shortly."],
    [500, "internal", "Something went wrong. Try again or reopen Telegram."],
  ] as const)("maps mutation status %i / code %s to the hook message", async (status, code, expected) => {
    apiMocks.postMiniAppSnapshot.mockRejectedValueOnce(new MiniAppRequestError(status, code as MiniAppErrorCode));
    const { result } = renderHook(() => useMiniAppMutations(makeArgs()));
    await act(async () => { await result.current.performMutation({ kind: "pause" }); });
    expect(result.current.message).toBe(expected);
  });

  it("runs Telegram write-access and home-screen probes once after successful mutations", async () => {
    const requestWriteAccess = vi.fn();
    const checkHomeScreenStatus = vi.fn((callback: (status: string) => void) => callback("missed"));
    const isVersionAtLeast = vi.fn((version: string) => version === "6.9" || version === "8.0");
    const webApp = makeWebApp({ isVersionAtLeast, requestWriteAccess, checkHomeScreenStatus });
    const state: TelegramMiniAppState = {
      ...baseState,
      viewer: { ...baseState.viewer, chatType: "sender" },
      subscriber: { ...baseState.subscriber, exists: false },
    };
    apiMocks.postMiniAppSnapshot.mockResolvedValue(makeSnapshot(baseState));
    const { result } = renderHook(() => useMiniAppMutations(makeArgs({ state, webApp })));

    expect(checkHomeScreenStatus).not.toHaveBeenCalled();
    await act(async () => { await result.current.performMutation(RECOMMENDED_OPERATION); });
    await act(async () => { await result.current.performMutation(RECOMMENDED_OPERATION); });
    expect(requestWriteAccess).toHaveBeenCalledOnce();
    expect(checkHomeScreenStatus).toHaveBeenCalledOnce();
    expect(result.current.homeScreenStatus).toBe("missed");
  });

  it("does not request write access for a private-chat launch", async () => {
    const requestWriteAccess = vi.fn();
    const webApp = makeWebApp({ isVersionAtLeast: () => true, requestWriteAccess });
    const state: TelegramMiniAppState = {
      ...baseState,
      subscriber: { ...baseState.subscriber, exists: false },
    };
    apiMocks.postMiniAppSnapshot.mockResolvedValueOnce(makeSnapshot());
    const { result } = renderHook(() => useMiniAppMutations(makeArgs({ state, webApp })));

    await act(async () => { await result.current.performMutation(RECOMMENDED_OPERATION); });
    expect(requestWriteAccess).not.toHaveBeenCalled();
  });

  it("keeps the remove undo subject for its five-second window and restores it with set-coin", async () => {
    const coin = baseState.subscriptions[0]!;
    const showConfirm = vi.fn((_message: string, callback: (confirmed: boolean) => void) => callback(true));
    const webApp = makeWebApp({ showConfirm });
    apiMocks.postMiniAppSnapshot.mockResolvedValue(makeSnapshot({ ...baseState, subscriptions: [] }));
    const { result } = renderHook(() => useMiniAppMutations(makeArgs({ webApp })));

    act(() => { result.current.remove(coin); });
    await waitFor(() => expect(result.current.pendingUndo).toEqual(coin));
    expect(showConfirm).toHaveBeenCalledWith("Remove USDC from your watchlist?", expect.any(Function));

    act(() => { result.current.undoRemove(); });
    await waitFor(() => expect(apiMocks.postMiniAppSnapshot).toHaveBeenCalledTimes(2));
    expect(apiMocks.postMiniAppSnapshot.mock.calls[1]?.[1]).toEqual({
      initData: "signed-init-data",
      operation: {
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: { alertTypes: { dews: true, depeg: true }, dewsMinBand: "ALERT", depegStepBps: 250 },
      },
    });
    expect(result.current.pendingUndo).toBeNull();
  });

  it("does not dispatch a canceled remove confirmation", () => {
    const showConfirm = vi.fn((_message: string, callback: (confirmed: boolean) => void) => callback(false));
    const coin = baseState.subscriptions[0]!;
    const { result } = renderHook(() => useMiniAppMutations(makeArgs({ webApp: makeWebApp({ showConfirm }) })));

    act(() => { result.current.remove(coin); });
    expect(showConfirm).toHaveBeenCalledWith("Remove USDC from your watchlist?", expect.any(Function));
    expect(apiMocks.postMiniAppSnapshot).not.toHaveBeenCalled();
  });

  it("expires the remove undo affordance after five seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const coin = baseState.subscriptions[0]!;
    const showConfirm = vi.fn((_message: string, callback: (confirmed: boolean) => void) => callback(true));
    apiMocks.postMiniAppSnapshot.mockResolvedValue(makeSnapshot({ ...baseState, subscriptions: [] }));
    const { result } = renderHook(() => useMiniAppMutations(makeArgs({ webApp: makeWebApp({ showConfirm }) })));

    act(() => { result.current.remove(coin); });
    await waitFor(() => expect(result.current.pendingUndo).toEqual(coin));
    await act(async () => { vi.advanceTimersByTime(5_001); });
    expect(result.current.pendingUndo).toBeNull();
  });

  it("keeps native two-step confirmation and forget-me terminal state in the hook", async () => {
    const showConfirm = vi.fn((_message: string, callback: (confirmed: boolean) => void) => callback(true));
    const webApp = makeWebApp({ showConfirm });
    apiMocks.postMiniAppSnapshot.mockResolvedValue(makeSnapshot());
    const { result } = renderHook(() => useMiniAppMutations(makeArgs({ webApp })));
    const preset = { id: "usd-top25", label: "USD Top 25", alertTypes: { dews: true, depeg: true, safety: false }, depegStepBps: 250 };

    act(() => { result.current.unsubscribeAll(); });
    await waitFor(() => expect(apiMocks.postMiniAppSnapshot).toHaveBeenCalledTimes(1));
    act(() => { result.current.unfollowPreset(preset); });
    await waitFor(() => expect(apiMocks.postMiniAppSnapshot).toHaveBeenCalledTimes(2));
    act(() => { result.current.forgetMe(); });
    await waitFor(() => expect(apiMocks.postMiniAppSnapshot).toHaveBeenCalledTimes(3));

    expect(showConfirm).toHaveBeenCalledTimes(4);
    expect(showConfirm.mock.calls.map(([message]) => message)).toEqual([
      "Unsubscribe from all alerts? This clears every coin, preset, and global toggle.",
      "Unfollow USD Top 25? Direct coin settings and overlapping presets will stay unchanged.",
      "Delete all your Pharos alert data? This cannot be undone.",
      "Are you absolutely sure? Your subscriber row will be deleted.",
    ]);
    expect(apiMocks.postMiniAppSnapshot.mock.calls[0]?.[1]).toEqual({ initData: "signed-init-data", operation: { kind: "unsubscribe-all" } });
    expect(apiMocks.postMiniAppSnapshot.mock.calls[1]?.[1]).toEqual({ initData: "signed-init-data", operation: { kind: "unfollow-preset", presetId: "usd-top25" } });
    expect(apiMocks.postMiniAppSnapshot.mock.calls[2]?.[1]).toEqual({ initData: "signed-init-data", operation: { kind: "forget-me" } });
    expect(result.current.forgottenView).toBe(true);
  });
});
