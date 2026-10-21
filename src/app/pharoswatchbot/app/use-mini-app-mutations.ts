"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { ALERT_LABELS, SNOOZE_DURATION_LABELS, presetLabel as presetCopyLabel } from "./constants";
import { formatQuietHoursRange } from "./format";
import {
  miniAppErrorMessage,
  MiniAppRequestError,
} from "./error-messages";
import {
  isMiniAppVersionMismatch,
  postMiniAppBulkWatchlistPreview,
  postMiniAppSnapshot,
  refreshMiniAppBundleOnce,
  type TelegramMiniAppClientSnapshot,
} from "./mini-app-api";
import type { TelegramWebAppSdk } from "./telegram-sdk";
import type {
  FollowedPreset,
  SubscribedCoin,
  TelegramMiniAppOperation,
  TelegramMiniAppBulkWatchlistOperation,
  TelegramMiniAppBulkWatchlistResponse,
  TelegramMiniAppState,
} from "./types";

const MUTATE_ENDPOINT = API_PATHS.telegramMiniAppMutation();

/** Grace period during which a removal or bulk edit can be undone from the snackbar. */
const UNDO_WINDOW_MS = 5_000;

type SignedReadOperation = Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }>;

function coinSymbol(state: TelegramMiniAppState | null, stablecoinId: string): string {
  return state?.subscriptions.find((c) => c.stablecoinId === stablecoinId)?.symbol
    ?? state?.catalog.searchableCoins.find((c) => c.stablecoinId === stablecoinId)?.symbol
    ?? "Coin";
}

function presetLabel(state: TelegramMiniAppState | null, presetId: string): string {
  return presetCopyLabel(presetId, state?.presets.find((preset) => preset.id === presetId)?.label
    ?? state?.catalog.recommendedPresets.find((preset) => preset.id === presetId)?.label
    ?? "Preset");
}

function countCoins(count: number): string {
  return `${count} ${count === 1 ? "coin" : "coins"}`;
}

/** User-facing confirmation for a saved change; also the stale-auth "Not saved" intent. */
export function mutationSuccessAnnouncement(operation: TelegramMiniAppOperation, state: TelegramMiniAppState | null): string {
  switch (operation.kind) {
    case "preview-bulk-watchlist":
    case "confirm-bulk-watchlist": {
      const added = operation.addStablecoinIds.length;
      const removed = operation.removeStablecoinIds.length;
      if (removed === 0) return `Added ${countCoins(added)}.`;
      if (added === 0) return `Removed ${countCoins(removed)}.`;
      return `Added ${countCoins(added)}, removed ${removed}.`;
    }
    case "undo-bulk-watchlist":
      return "Change undone.";
    case "recommended-setup":
      return "Following USD Top 25: early warnings and depegs.";
    case "set-global":
      return `All stablecoins: ${ALERT_LABELS[operation.alertType]} ${operation.enabled ? "on" : "off"}.`;
    case "set-global-depeg-step":
      return "All stablecoins: depeg re-alerts updated.";
    case "set-quiet-hours":
      return operation.enabled
        ? operation.startHourUtc != null && operation.endHourUtc != null
          ? `Quiet hours ${formatQuietHoursRange(operation.startHourUtc, operation.endHourUtc)}.`
          : "Quiet hours on."
        : "Quiet hours off.";
    case "clear-snooze":
      return "Alerts resumed.";
    case "set-coin": {
      const symbol = coinSymbol(state, operation.stablecoinId);
      const changed = Object.entries(operation.patch.alertTypes ?? {});
      if (changed.length === 1 && Object.keys(operation.patch).length === 1) {
        const [type, enabled] = changed[0] as [keyof typeof ALERT_LABELS, boolean];
        return `${symbol}: ${ALERT_LABELS[type]} ${enabled ? "on" : "off"}.`;
      }
      return `${symbol} updated.`;
    }
    case "remove-coin":
      return `${coinSymbol(state, operation.stablecoinId)} removed.`;
    case "set-snooze":
      return `Snoozed for ${SNOOZE_DURATION_LABELS[operation.durationToken]}.`;
    case "pause":
      return "Alerts paused until you resume.";
    case "set-coin-snooze": {
      const symbol = coinSymbol(state, operation.stablecoinId);
      return operation.durationToken === "clear"
        ? `${symbol} snooze cleared.`
        : `${symbol} snoozed for ${SNOOZE_DURATION_LABELS[operation.durationToken]}.`;
    }
    case "set-timezone":
      return operation.timezone == null ? "Time zone cleared." : `Time zone set to ${operation.timezone}.`;
    case "unsubscribe-all":
      return "Unsubscribed from all alerts.";
    case "forget-me":
      return "All your data has been deleted.";
    case "follow-preset":
      return state?.presets.some((preset) => preset.id === operation.presetId)
        ? `${presetLabel(state, operation.presetId)} updated.`
        : `Following ${presetLabel(state, operation.presetId)}.`;
    case "unfollow-preset":
      return `Unfollowed ${presetLabel(state, operation.presetId)}.`;
  }
}

function isStaleAuthError(err: unknown): boolean {
  return err instanceof MiniAppRequestError && err.status === 401 && err.code === "stale-auth";
}

function staleAuthIntent(operation: TelegramMiniAppOperation, state: TelegramMiniAppState | null): string {
  if (operation.kind === "forget-me") return "Data deletion was not run.";
  return `Not saved: ${mutationSuccessAnnouncement(operation, state)}`;
}

function confirmThenFire(
  confirmFn: TelegramWebAppSdk["showConfirm"] | undefined,
  message: string,
  fire: () => void,
  cancel?: () => void,
) {
  if (!confirmFn) {
    fire();
    return;
  }
  confirmFn(message, (confirmed) => {
    if (confirmed) fire();
    else cancel?.();
  });
}

export interface UseMiniAppMutationsArgs {
  /** Signed Telegram launch payload. The hook is a no-op until this is non-empty. */
  initData: string;
  /** Latest server snapshot, or `null` before the first successful session load. */
  state: TelegramMiniAppState | null;
  /** Telegram WebApp handle (for haptics, closing-confirmation, requestWriteAccess, checkHomeScreenStatus). */
  webApp: TelegramWebAppSdk | null;
  /** Replace the confirmed server snapshot after a successful non-`forget-me` mutation. */
  onSnapshotReplaced: (next: TelegramMiniAppClientSnapshot) => void;
  /** Revoke the session and clear retained data after confirmed deletion. */
  onForgotten: () => void;
  /**
   * Telegram launch auth is known to be expired. Telegram never refreshes
   * `initData` inside a running Mini App, so edits are kept as visible intent
   * and never sent; only a fresh launch can save them.
   */
  authExpired: boolean;
  /** False while session state is refreshing, stale, or otherwise read-only. */
  mutationsAllowed: boolean;
  /** Signed private-session reads remain available through Telegram's 24h window. */
  signedReadsAllowed: boolean;
  /** A signed read hit `stale-auth`: the 24h session window is over and no signed request can succeed. */
  onSessionAuthExpired: () => void;
}

/** One snackbar message. Errors persist until dismissed; success hides itself. */
export interface MiniAppNotice {
  id: number;
  tone: "success" | "error";
  text: string;
  /** Present while an undo for this change is still valid. */
  undoLabel?: string;
}

export interface UseMiniAppMutationsResult {
  /** True between dispatch and either resolve or reject of `performMutation`. */
  isMutating: boolean;
  /** Mutation currently in flight, used for scoped control feedback. */
  pendingOperation: TelegramMiniAppOperation | null;
  /** Remaining server-directed edit lockout after a bounded-burst 429. */
  mutationRetryAfterSec: number;
  /** Latest success, error or undo message for the bottom snackbar. */
  notice: MiniAppNotice | null;
  /** Aria-live announcement for state changes that are not snackbar messages. */
  announcement: string;
  /** True once `forget-me` has resolved successfully — caller should switch to terminal view. */
  forgottenView: boolean;
  /** Returned status when `checkHomeScreenStatus` probe ran. Null until then. */
  homeScreenStatus: string | null;
  /**
   * Non-null once a request was rejected with `stale-auth` or an edit was
   * attempted while `authExpired`; `intent` describes the unsaved edit.
   */
  staleAuth: { intent: string | null } | null;

  /** Dispatch a mutation without changing visible values before server confirmation. */
  mutate: (operation: TelegramMiniAppOperation) => void;
  /** Imperative dispatch returning the confirmed server snapshot on success. */
  performMutation: (operation: TelegramMiniAppOperation) => Promise<TelegramMiniAppClientSnapshot | null>;
  /** Signed read-only bulk preview request. Does not consume edit burst capacity. */
  performBulkWatchlistPreview: (operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }>) => Promise<TelegramMiniAppBulkWatchlistResponse | null>;
  /** Preview then confirm a multi-coin add/remove; arms an undo in the snackbar. Resolves true on success. */
  applyBulkWatchlist: (addStablecoinIds: string[], removeStablecoinIds: string[]) => Promise<boolean>;
  /** Confirm-then-remove one coin; arms an undo in the snackbar. Resolves true on success. */
  remove: (coin: SubscribedCoin) => Promise<boolean>;
  /** Run the snackbar undo. No-op once the window has expired. */
  undo: () => void;
  /** Hide the current snackbar message. */
  dismissNotice: () => void;
  /** Show a client-side validation message in the snackbar. */
  showError: (text: string) => void;

  /** Imperative hook for the "add to home screen" row. */
  addToHomeScreen: () => void;

  /** Confirm-then-unfollow flow for a followed group. Resolves true on success. */
  unfollowPreset: (preset: FollowedPreset) => Promise<boolean>;
  /** Confirm-then-pause flow ("until I resume"). */
  pause: () => void;
  /** Confirm-then-unsubscribe-all flow for the Settings data section. */
  unsubscribeAll: () => void;
  /** Two-step confirm forget-me flow for the Settings data section. */
  forgetMe: () => void;
}

type UndoOperation = Extract<TelegramMiniAppOperation, { kind: "undo-bulk-watchlist" }>;

/**
 * Server-confirmed mutation flow + pending feedback + undo + snackbar notices.
 *
 * Fragile invariants this hook protects:
 * 1. Visible values remain at the last confirmed snapshot while a request is pending.
 *    `pendingOperation` drives scoped `aria-busy` feedback and the server response owns the update.
 * 2. T-57 (`requestWriteAccess`) and T-58 (`checkHomeScreenStatus`) one-shot refs live in
 *    this hook and persist across renders for the browser session.
 * 3. `enableClosingConfirmation` / `disableClosingConfirmation` are paired around the
 *    `performMutation` POST in a `try/finally`.
 * 4. `unsubscribeAll` clears any pending undo before dispatching — otherwise the snackbar
 *    would point at a coin that no longer exists in the just-emptied subscriber row.
 * 5. Undo only ever replays the server-derived snapshot (`undo-bulk-watchlist`), never a
 *    patch reconstructed from rendered state, and never retries automatically.
 */
export function useMiniAppMutations(args: UseMiniAppMutationsArgs): UseMiniAppMutationsResult {
  const {
    initData,
    state,
    webApp,
    onSnapshotReplaced,
    onForgotten,
    authExpired,
    mutationsAllowed,
    signedReadsAllowed,
    onSessionAuthExpired,
  } = args;
  // webApp identity is stable per render, so showConfirm is safe to hoist once.
  const showConfirm = webApp?.showConfirm;
  const [isMutating, setIsMutating] = useState(false);
  const [notice, setNotice] = useState<MiniAppNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const undoOperationRef = useRef<UndoOperation | null>(null);
  const noticeIdRef = useRef(0);
  const [homeScreenStatus, setHomeScreenStatus] = useState<string | null>(null);
  const [forgottenView, setForgottenView] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<TelegramMiniAppOperation | null>(null);
  const [mutationRetryAfterSec, setMutationRetryAfterSec] = useState(0);
  const [staleAuth, setStaleAuth] = useState<{ intent: string | null } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRequestedWriteAccessRef = useRef(false);
  const hasMutatedThisSessionRef = useRef(false);
  const hasProbedHomeScreenRef = useRef(false);
  const mutationLimitWasActiveRef = useRef(false);
  const terminalRef = useRef(false);
  const requestInFlightRef = useRef(false);

  const clearUndo = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    undoOperationRef.current = null;
    setNotice((current) => (current?.undoLabel ? { ...current, undoLabel: undefined } : current));
  }, []);

  const showNotice = useCallback((tone: MiniAppNotice["tone"], text: string, undo?: UndoOperation) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    undoOperationRef.current = undo ?? null;
    noticeIdRef.current += 1;
    setNotice({ id: noticeIdRef.current, tone, text, ...(undo ? { undoLabel: "Undo" } : {}) });
    if (undo) {
      undoTimerRef.current = setTimeout(() => {
        undoTimerRef.current = null;
        undoOperationRef.current = null;
        setNotice((current) => (current?.undoLabel ? { ...current, undoLabel: undefined } : current));
      }, UNDO_WINDOW_MS);
    }
  }, []);

  const dismissNotice = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    undoOperationRef.current = null;
    setNotice(null);
  }, []);

  const showError = useCallback((text: string) => {
    showNotice("error", text);
    webApp?.HapticFeedback?.notificationOccurred?.("error");
  }, [showNotice, webApp]);

  useEffect(() => {
    if (mutationRetryAfterSec <= 0) {
      if (mutationLimitWasActiveRef.current) {
        mutationLimitWasActiveRef.current = false;
        setAnnouncement("Pharos editing is available again.");
      }
      return;
    }
    mutationLimitWasActiveRef.current = true;
    const timer = setTimeout(() => {
      setMutationRetryAfterSec((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [mutationRetryAfterSec]);

  const performMutation = useCallback(async (operation: TelegramMiniAppOperation): Promise<TelegramMiniAppClientSnapshot | null> => {
    if (terminalRef.current) return null;
    if (authExpired || staleAuth) {
      // Resending the frozen initData is guaranteed to fail; keep the intent visible instead.
      setStaleAuth({ intent: staleAuthIntent(operation, state) });
      setAnnouncement("Change not saved. Reopen the Mini App to edit.");
      webApp?.HapticFeedback?.notificationOccurred?.("warning");
      return null;
    }
    if (requestInFlightRef.current) {
      // Never drop an edit silently: say why it did not go out.
      showNotice("error", "Still saving your last change. Try again in a moment.");
      return null;
    }
    if (!initData || !mutationsAllowed || state?.viewer.canMutate !== true || mutationRetryAfterSec > 0) return null;
    requestInFlightRef.current = true;
    // Capture pre-mutation snapshot for engagement gating (T-57) and success copy.
    const preState = state;
    const preSubscriberExists = state?.subscriber.exists ?? false;
    const preChatType = state?.viewer.chatType ?? null;
    setIsMutating(true);
    setPendingOperation(operation);
    webApp?.enableClosingConfirmation?.();
    try {
      const next = await postMiniAppSnapshot(MUTATE_ENDPOINT, { initData, operation });
      if (operation.kind === "forget-me") {
        terminalRef.current = true;
        dismissNotice();
        onForgotten();
        setForgottenView(true);
        setAnnouncement(mutationSuccessAnnouncement(operation, next.state));
        webApp?.HapticFeedback?.notificationOccurred?.("success");
        return next;
      }
      onSnapshotReplaced(next);
      showNotice("success", mutationSuccessAnnouncement(operation, preState ?? next.state));
      const haptics = webApp?.HapticFeedback;
      if (operation.kind === "recommended-setup" || operation.kind === "set-coin" || operation.kind === "remove-coin" || operation.kind === "confirm-bulk-watchlist") {
        haptics?.notificationOccurred?.("success");
      } else {
        haptics?.impactOccurred?.("light");
      }
      // T-57: requestWriteAccess once, after the first successful recommended-setup
      // for sender-launched users who had no subscriber row before.
      if (
        operation.kind === "recommended-setup"
        && !hasRequestedWriteAccessRef.current
        && !preSubscriberExists
        && preChatType === "sender"
        && webApp?.isVersionAtLeast?.("6.9")
        && typeof webApp.requestWriteAccess === "function"
      ) {
        hasRequestedWriteAccessRef.current = true;
        webApp.requestWriteAccess();
      }
      // T-58: probe home-screen status once after the first successful mutation.
      if (!hasMutatedThisSessionRef.current) {
        hasMutatedThisSessionRef.current = true;
        if (
          !hasProbedHomeScreenRef.current
          && webApp?.isVersionAtLeast?.("8.0")
          && typeof webApp.checkHomeScreenStatus === "function"
        ) {
          hasProbedHomeScreenRef.current = true;
          webApp.checkHomeScreenStatus((nextStatus) => {
            setHomeScreenStatus(nextStatus);
          });
        }
      }
      return next;
    } catch (err) {
      if (isMiniAppVersionMismatch(err)) {
        refreshMiniAppBundleOnce({
          contractVersion: err.serverContractVersion,
          catalogVersion: err.serverCatalogVersion,
        });
        showNotice("error", miniAppErrorMessage(err, "mutation"));
      } else if (err instanceof MiniAppRequestError && err.status === 429 && err.code === "rate-limited") {
        const retryAfterSec = err.retryAfterSec ?? 1;
        setMutationRetryAfterSec((current) => Math.max(current, retryAfterSec));
        setAnnouncement(`Pharos edit limit reached. Settings are disabled for ${retryAfterSec} ${retryAfterSec === 1 ? "second" : "seconds"}.`);
      } else if (isStaleAuthError(err)) {
        setStaleAuth({ intent: staleAuthIntent(operation, state) });
        setAnnouncement("Change not saved. Reopen the Mini App to edit.");
      } else {
        showNotice("error", miniAppErrorMessage(err, "mutation"));
      }
      webApp?.HapticFeedback?.notificationOccurred?.("error");
      return null;
    } finally {
      setIsMutating(false);
      requestInFlightRef.current = false;
      setPendingOperation(null);
      webApp?.disableClosingConfirmation?.();
    }
  }, [authExpired, dismissNotice, initData, mutationRetryAfterSec, mutationsAllowed, onForgotten, onSnapshotReplaced, showNotice, staleAuth, state, webApp]);

  const mutate = useCallback((operation: TelegramMiniAppOperation) => {
    void performMutation(operation);
  }, [performMutation]);

  const performSignedRead = useCallback(async <T>(
    operation: SignedReadOperation,
    request: () => Promise<T>,
  ): Promise<T | null> => {
    if (terminalRef.current || requestInFlightRef.current || !initData || !signedReadsAllowed || state?.viewer.chatId == null || isMutating) return null;
    requestInFlightRef.current = true;
    setIsMutating(true);
    setPendingOperation(operation);
    try {
      return await request();
    } catch (err) {
      if (isMiniAppVersionMismatch(err)) {
        refreshMiniAppBundleOnce({
          contractVersion: err.serverContractVersion,
          catalogVersion: err.serverCatalogVersion,
        });
      }
      if (isStaleAuthError(err)) {
        setStaleAuth((current) => current ?? { intent: null });
        onSessionAuthExpired();
      } else {
        showNotice("error", miniAppErrorMessage(err, "mutation"));
      }
      webApp?.HapticFeedback?.notificationOccurred?.("error");
      return null;
    } finally {
      setIsMutating(false);
      requestInFlightRef.current = false;
      setPendingOperation(null);
    }
  }, [initData, isMutating, onSessionAuthExpired, showNotice, signedReadsAllowed, state?.viewer.chatId, webApp]);

  const performBulkWatchlistPreview = useCallback(async (
    operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }>,
  ): Promise<TelegramMiniAppBulkWatchlistResponse | null> => performSignedRead(
    operation,
    () => postMiniAppBulkWatchlistPreview(MUTATE_ENDPOINT, { initData, operation }),
  ), [initData, performSignedRead]);

  const applyBulkWatchlist = useCallback(async (addStablecoinIds: string[], removeStablecoinIds: string[]): Promise<boolean> => {
    const selection = { addStablecoinIds, removeStablecoinIds };
    if (authExpired || staleAuth) {
      // Same visible-intent path as performMutation; the preview read would fail too.
      setStaleAuth({ intent: staleAuthIntent({ kind: "preview-bulk-watchlist", ...selection }, state) });
      setAnnouncement("Change not saved. Reopen the Mini App to edit.");
      webApp?.HapticFeedback?.notificationOccurred?.("warning");
      return false;
    }
    const response = await performBulkWatchlistPreview({ kind: "preview-bulk-watchlist", ...selection });
    if (response?.result.kind !== "bulk-watchlist-preview") return false;
    const preview = response.result;
    const next = await performMutation({
      kind: "confirm-bulk-watchlist",
      ...selection,
      expectedPreferenceGeneration: preview.expectedPreferenceGeneration,
      previewFingerprint: preview.previewFingerprint,
    });
    if (!next) return false;
    showNotice("success", mutationSuccessAnnouncement({
      kind: "confirm-bulk-watchlist",
      ...selection,
      expectedPreferenceGeneration: preview.expectedPreferenceGeneration,
      previewFingerprint: preview.previewFingerprint,
    }, next.state), { kind: "undo-bulk-watchlist", ...preview.undo });
    return true;
  }, [authExpired, performBulkWatchlistPreview, performMutation, showNotice, staleAuth, state, webApp]);

  const remove = useCallback((coin: SubscribedCoin) => new Promise<boolean>((resolve) => {
    const fire = () => void (async () => {
      const next = await performMutation({ kind: "remove-coin", stablecoinId: coin.stablecoinId });
      if (!next) {
        resolve(false);
        return;
      }
      showNotice("success", `${coin.symbol} removed.`, next.undo ? { kind: "undo-bulk-watchlist", ...next.undo } : undefined);
      resolve(true);
    })();
    confirmThenFire(showConfirm, `Remove ${coin.symbol} from your coins?`, fire, () => resolve(false));
  }), [performMutation, showConfirm, showNotice]);

  const undo = useCallback(() => {
    const captured = undoOperationRef.current;
    // Keep the undo armed while another save is in flight; the button is disabled meanwhile.
    if (!captured || requestInFlightRef.current) return;
    // Success or failure replaces the notice (and its undo) with a visible result.
    void performMutation(captured);
  }, [performMutation]);

  const unfollowPreset = useCallback((preset: FollowedPreset) => new Promise<boolean>((resolve) => {
    // Group membership is dynamic, so always confirm when the bridge exposes a native sheet (T-48).
    confirmThenFire(showConfirm, `Unfollow ${presetCopyLabel(preset.id, preset.label)}? Coins you added yourself stay as they are.`, () => {
      void performMutation({ kind: "unfollow-preset", presetId: preset.id }).then((next) => resolve(next != null));
    }, () => resolve(false));
  }), [performMutation, showConfirm]);

  const pause = useCallback(() => {
    confirmThenFire(showConfirm, "Pause all alerts until you resume them?", () => {
      void performMutation({ kind: "pause" });
    });
  }, [performMutation, showConfirm]);

  const unsubscribeAll = useCallback(() => {
    // R3 fix: clear any pending undo before unsubscribing-all so the snackbar cannot
    // re-add a coin to a now-empty subscriber row.
    const fire = () => {
      clearUndo();
      void performMutation({ kind: "unsubscribe-all" });
    };
    confirmThenFire(showConfirm, "Unsubscribe from all alerts? This clears every coin, preset, and All stablecoins setting.", fire);
  }, [clearUndo, performMutation, showConfirm]);

  const forgetMe = useCallback(() => {
    // Destructive, irreversible op: keep the confirmed state visible until
    // the server accepts deletion, then switch to the terminal view.
    const fire = () => void performMutation({ kind: "forget-me" });
    confirmThenFire(showConfirm, "Delete all your Pharos alert data? This cannot be undone.", () => {
      confirmThenFire(showConfirm, "Are you absolutely sure? Your alerts and settings will be deleted.", fire);
    });
  }, [performMutation, showConfirm]);

  const addToHomeScreen = useCallback(() => {
    webApp?.addToHomeScreen?.();
    webApp?.HapticFeedback?.impactOccurred?.("light");
    webApp?.checkHomeScreenStatus?.((nextStatus) => {
      setHomeScreenStatus(nextStatus);
    });
  }, [webApp]);

  // Unmount cleanup for the undo timer owned by this hook.
  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  return {
    isMutating,
    pendingOperation,
    mutationRetryAfterSec,
    notice,
    announcement,
    forgottenView,
    homeScreenStatus,
    staleAuth,
    mutate,
    performMutation,
    performBulkWatchlistPreview,
    applyBulkWatchlist,
    remove,
    undo,
    dismissNotice,
    showError,
    addToHomeScreen,
    unfollowPreset,
    pause,
    unsubscribeAll,
    forgetMe,
  };
}
