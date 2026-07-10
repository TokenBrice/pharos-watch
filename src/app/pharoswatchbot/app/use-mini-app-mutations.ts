"use client";

import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { ALERT_LABELS } from "./constants";
import {
  miniAppErrorMessage,
  MiniAppRequestError,
} from "./error-messages";
import { postMiniAppJson, TelegramMiniAppStateSchema } from "./mini-app-api";
import type { TelegramWebAppSdk } from "./telegram-sdk";
import type {
  FollowedPreset,
  SubscribedCoin,
  TelegramAlertType,
  TelegramDepegStepBps,
  TelegramMiniAppOperation,
  TelegramMiniAppState,
} from "./types";

const MUTATE_ENDPOINT = API_PATHS.telegramMiniAppMutation();

/** Grace period during which a removed coin can be restored via the undo toast. */
const UNDO_WINDOW_MS = 5_000;

function mutationSuccessAnnouncement(operation: TelegramMiniAppOperation, state: TelegramMiniAppState | null): string {
  switch (operation.kind) {
    case "recommended-setup":
      return "Recommended setup applied.";
    case "set-global":
      return `${ALERT_LABELS[operation.alertType]} alerts ${operation.enabled ? "enabled" : "disabled"}.`;
    case "set-global-depeg-step":
      return operation.depegStepBps == null ? "Global depeg step cleared." : `Global depeg step set to ${operation.depegStepBps} bps.`;
    case "set-quiet-hours":
      return operation.enabled ? "Quiet hours updated." : "Quiet hours disabled.";
    case "clear-snooze":
      return "Snooze cleared.";
    case "set-coin": {
      const symbol = state?.subscriptions.find((c) => c.stablecoinId === operation.stablecoinId)?.symbol
        ?? state?.catalog.searchableCoins.find((c) => c.stablecoinId === operation.stablecoinId)?.symbol
        ?? "Coin";
      return `${symbol} updated.`;
    }
    case "remove-coin": {
      const symbol = state?.subscriptions.find((c) => c.stablecoinId === operation.stablecoinId)?.symbol ?? "Coin";
      return `${symbol} removed from watchlist.`;
    }
    case "set-snooze":
      return `Snoozed for ${operation.durationToken}.`;
    case "pause":
      return "All alerts paused.";
    case "set-coin-snooze": {
      const symbol = state?.subscriptions.find((c) => c.stablecoinId === operation.stablecoinId)?.symbol ?? "Coin";
      return operation.durationToken === "clear"
        ? `${symbol} snooze cleared.`
        : `${symbol} snoozed for ${operation.durationToken}.`;
    }
    case "set-timezone":
      return operation.timezone == null ? "Timezone cleared." : `Timezone set to ${operation.timezone}.`;
    case "unsubscribe-all":
      return "All subscriptions cleared.";
    case "forget-me":
      return "All your data has been deleted.";
    case "follow-preset":
      return "Preset followed.";
    case "unfollow-preset":
      return "Preset unfollowed.";
  }
}

function optimisticGlobalAlerts(state: TelegramMiniAppState, operation: TelegramMiniAppOperation): Record<TelegramAlertType, boolean> & { depegStepBps: TelegramDepegStepBps | null } {
  const base = state.subscriber.globalAlerts;
  if (operation.kind === "set-global") {
    return { ...base, [operation.alertType]: operation.enabled };
  }
  if (operation.kind === "set-global-depeg-step") {
    return { ...base, depegStepBps: operation.depegStepBps };
  }
  return base;
}

function defaultGlobalAlerts(): TelegramMiniAppState["subscriber"]["globalAlerts"] {
  return { dews: false, depeg: false, safety: false, launch: false, reserve: false, depegStepBps: null };
}

function confirmThenFire(
  confirmFn: TelegramWebAppSdk["showConfirm"] | undefined,
  message: string,
  fire: () => void,
) {
  if (!confirmFn) {
    fire();
    return;
  }
  confirmFn(message, (confirmed) => {
    if (confirmed) fire();
  });
}

export interface UseMiniAppMutationsArgs {
  /** Signed Telegram launch payload. The hook is a no-op until this is non-empty. */
  initData: string;
  /** Latest server snapshot, or `null` before the first successful session load. */
  state: TelegramMiniAppState | null;
  /** Telegram WebApp handle (for haptics, closing-confirmation, requestWriteAccess, checkHomeScreenStatus). */
  webApp: TelegramWebAppSdk | null;
  /** Replace the server snapshot. Called after every successful non-`forget-me` mutation. */
  onStateReplaced: (next: TelegramMiniAppState) => void;
  /** Reload the session (used on 401/stale-auth recovery). */
  reloadSession: (options?: { clearMessage?: boolean }) => Promise<void>;
  /** Whether the 6s message auto-dismiss is active. Caller passes `status === "ready"`. */
  messageAutoDismissActive: boolean;
}

export interface UseMiniAppMutationsResult {
  /** Composite optimistic snapshot, or `null` while `state` is `null`. */
  optimisticState: TelegramMiniAppState | null;
  /** Optimistic global alerts object (separate handle because `SettingsPanel` consumes it independently). */
  optimisticGlobals: TelegramMiniAppState["subscriber"]["globalAlerts"];
  /** True between dispatch and either resolve or reject of `performMutation`. */
  isMutating: boolean;
  /** Mutation currently in flight, used for scoped control feedback. */
  pendingOperation: TelegramMiniAppOperation | null;
  /** Remaining server-directed edit lockout after a bounded-burst 429. */
  mutationRetryAfterSec: number;
  /** Banner copy. Auto-clears 6s after set when `messageAutoDismissActive` is true. */
  message: string | null;
  /** Aria-live announcement. */
  announcement: string;
  /** True once `forget-me` has resolved successfully — caller should switch to terminal view. */
  forgottenView: boolean;
  /** Undo toast state. Non-null between successful `remove-coin` resolve and the 5s expiry. */
  pendingUndo: SubscribedCoin | null;
  /** Returned status when `checkHomeScreenStatus` probe ran. Null until then. */
  homeScreenStatus: string | null;

  /** Optimistic dispatch for non-destructive local mutations; server-resolved preset follows dispatch directly. */
  mutate: (operation: TelegramMiniAppOperation) => void;
  /** Imperative dispatch: skips optimistic layer, returns the server snapshot on success. */
  performMutation: (operation: TelegramMiniAppOperation) => Promise<TelegramMiniAppState | null>;
  /** Bound handler for the remove-coin flow: confirm-then-mutate + arm undo on success. */
  remove: (coin: SubscribedCoin) => void;
  /** Bound handler for the undo button. No-op if `pendingUndo` is null. */
  undoRemove: () => void;

  /** Imperative hook for the "add to home screen" CTA in StatusPanel. */
  addToHomeScreen: () => void;

  /** Confirm-then-unfollow flow for the Presets panel. */
  unfollowPreset: (preset: FollowedPreset) => void;
  /** Confirm-then-unsubscribe-all flow for the Settings danger zone. */
  unsubscribeAll: () => void;
  /** Two-step confirm forget-me flow for the Settings danger zone. */
  forgetMe: () => void;

  /** Allow callers to set the banner explicitly (e.g. session-bootstrap errors). */
  setMessage: (next: string | null) => void;
}

/**
 * Mutation flow + optimistic state + undo + message/announcement + post-mutation one-shots.
 *
 * Fragile invariants this hook protects:
 * 1. `applyOptimisticOperation(op)` is called inside `startTransition`, and `performMutation`
 *    is fired as a non-awaited Promise OUTSIDE that transition. React 19 reverts the
 *    optimistic value automatically when the surrounding transition rejects, so failure
 *    handling does not manually rewrite optimistic state.
 * 2. T-57 (`requestWriteAccess`) and T-58 (`checkHomeScreenStatus`) one-shot refs live in
 *    this hook and persist across renders for the browser session.
 * 3. `enableClosingConfirmation` / `disableClosingConfirmation` are paired around the
 *    `performMutation` POST in a `try/finally`.
 * 4. `unsubscribeAll` clears any pending undo before dispatching — otherwise the toast
 *    would point at a coin that no longer exists in the just-emptied subscriber row.
 */
export function useMiniAppMutations(args: UseMiniAppMutationsArgs): UseMiniAppMutationsResult {
  const { initData, state, webApp, onStateReplaced, reloadSession, messageAutoDismissActive } = args;
  // webApp identity is stable per render, so showConfirm is safe to hoist once.
  const showConfirm = webApp?.showConfirm;
  const [isMutating, setIsMutating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pendingUndo, setPendingUndo] = useState<SubscribedCoin | null>(null);
  const [homeScreenStatus, setHomeScreenStatus] = useState<string | null>(null);
  const [forgottenView, setForgottenView] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<TelegramMiniAppOperation | null>(null);
  const [mutationRetryAfterSec, setMutationRetryAfterSec] = useState(0);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRequestedWriteAccessRef = useRef(false);
  const hasMutatedThisSessionRef = useRef(false);
  const hasProbedHomeScreenRef = useRef(false);
  const mutationLimitWasActiveRef = useRef(false);
  const [, startTransition] = useTransition();

  const [optimisticOperation, applyOptimisticOperation] = useOptimistic<
    TelegramMiniAppOperation | null,
    TelegramMiniAppOperation | null
  >(null, (_prev, next) => next);

  const optimisticGlobals = useMemo(() => {
    if (state && optimisticOperation) return optimisticGlobalAlerts(state, optimisticOperation);
    return state?.subscriber.globalAlerts ?? defaultGlobalAlerts();
  }, [state, optimisticOperation]);

  const subscriptionsForView: TelegramMiniAppState["subscriptions"] = useMemo(() => {
    if (!state) return [];
    if (!optimisticOperation || optimisticOperation.kind !== "set-coin") return state.subscriptions;
    return state.subscriptions.map((coin) => {
      if (coin.stablecoinId !== optimisticOperation.stablecoinId) return coin;
      const patch = optimisticOperation.patch;
      const nextAlertTypes = patch.alertTypes
        ? { ...coin.alertTypes, ...patch.alertTypes }
        : coin.alertTypes;
      const nextAlertOverrides = patch.alertTypes
        ? {
            dews: false,
            depeg: false,
            safety: false,
            launch: false,
            reserve: false,
            ...coin.alertOverrides,
            ...Object.fromEntries(Object.keys(patch.alertTypes).map((type) => [type, true])),
          }
        : coin.alertOverrides;
      return {
        ...coin,
        alertTypes: nextAlertTypes,
        alertOverrides: nextAlertOverrides,
        dewsMinBand: patch.dewsMinBand !== undefined ? patch.dewsMinBand : coin.dewsMinBand,
        depegStepBps: patch.depegStepBps !== undefined ? patch.depegStepBps : coin.depegStepBps,
        safetyMode: patch.safetyMode !== undefined ? patch.safetyMode : coin.safetyMode,
      };
    });
  }, [state, optimisticOperation]);

  const optimisticState: TelegramMiniAppState | null = useMemo(() => {
    if (!state) return null;
    return {
      ...state,
      subscriber: { ...state.subscriber, globalAlerts: optimisticGlobals },
      subscriptions: subscriptionsForView,
    };
  }, [state, optimisticGlobals, subscriptionsForView]);

  // 6s message auto-dismiss while the parent reports the session is ready.
  useEffect(() => {
    if (messageTimerRef.current) {
      clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    if (!message || !messageAutoDismissActive) return;
    messageTimerRef.current = setTimeout(() => {
      setMessage(null);
      messageTimerRef.current = null;
    }, 6_000);
    return () => {
      if (messageTimerRef.current) {
        clearTimeout(messageTimerRef.current);
        messageTimerRef.current = null;
      }
    };
  }, [message, messageAutoDismissActive]);

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

  const performMutation = useCallback(async (operation: TelegramMiniAppOperation): Promise<TelegramMiniAppState | null> => {
    if (!initData || state?.viewer.canMutate !== true || mutationRetryAfterSec > 0) return null;
    // Capture pre-mutation snapshot for engagement gating (T-57).
    const preSubscriberExists = state?.subscriber.exists ?? false;
    const preChatType = state?.viewer.chatType ?? null;
    setIsMutating(true);
    setPendingOperation(operation);
    webApp?.enableClosingConfirmation?.();
    try {
      const next = await postMiniAppJson(MUTATE_ENDPOINT, { initData, operation }, TelegramMiniAppStateSchema);
      if (operation.kind === "forget-me") {
        // Render the terminal screen instead of swapping state.
        setForgottenView(true);
        setMessage(null);
        setAnnouncement(mutationSuccessAnnouncement(operation, next));
        webApp?.HapticFeedback?.notificationOccurred?.("success");
        return next;
      }
      onStateReplaced(next);
      setMessage(null);
      setAnnouncement(mutationSuccessAnnouncement(operation, next));
      const haptics = webApp?.HapticFeedback;
      if (operation.kind === "recommended-setup" || operation.kind === "set-coin" || operation.kind === "remove-coin") {
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
      if (err instanceof MiniAppRequestError && err.status === 429 && err.code === "rate-limited") {
        const retryAfterSec = err.retryAfterSec ?? 1;
        setMutationRetryAfterSec((current) => Math.max(current, retryAfterSec));
        setMessage(null);
        setAnnouncement(`Pharos edit limit reached. Settings are disabled for ${retryAfterSec} ${retryAfterSec === 1 ? "second" : "seconds"}.`);
      } else {
        setMessage(miniAppErrorMessage(err, "mutation"));
      }
      webApp?.HapticFeedback?.notificationOccurred?.("error");
      if (err instanceof MiniAppRequestError && err.status === 401 && err.code === "stale-auth") {
        await reloadSession({ clearMessage: false });
      }
      return null;
    } finally {
      setIsMutating(false);
      setPendingOperation(null);
      webApp?.disableClosingConfirmation?.();
    }
  }, [initData, mutationRetryAfterSec, onStateReplaced, reloadSession, state?.subscriber.exists, state?.viewer.canMutate, state?.viewer.chatType, webApp]);

  const mutate = useCallback((operation: TelegramMiniAppOperation) => {
    if (operation.kind === "recommended-setup" || operation.kind === "follow-preset") {
      void performMutation(operation);
      return;
    }
    startTransition(() => {
      applyOptimisticOperation(operation);
    });
    void performMutation(operation);
  }, [applyOptimisticOperation, performMutation]);

  const clearUndoToast = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setPendingUndo(null);
  }, []);

  const remove = useCallback((coin: SubscribedCoin) => {
    const fire = () => void (async () => {
      const next = await performMutation({ kind: "remove-coin", stablecoinId: coin.stablecoinId });
      if (!next) return;
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setPendingUndo(coin);
      undoTimerRef.current = setTimeout(() => {
        setPendingUndo(null);
        undoTimerRef.current = null;
      }, UNDO_WINDOW_MS);
    })();
    confirmThenFire(showConfirm, `Remove ${coin.symbol} from your watchlist?`, fire);
  }, [performMutation, showConfirm]);

  const undoRemove = useCallback(() => {
    const captured = pendingUndo;
    if (!captured) return;
    clearUndoToast();
    const restoredAlertTypes = Object.fromEntries(
      (Object.keys(captured.alertTypes) as TelegramAlertType[])
        .filter((type) => captured.alertTypes[type] || captured.alertOverrides?.[type])
        .map((type) => [type, captured.alertTypes[type]]),
    ) as Partial<Record<TelegramAlertType, boolean>>;
    const patch: { alertTypes: Partial<Record<TelegramAlertType, boolean>>; dewsMinBand?: typeof captured.dewsMinBand; depegStepBps?: typeof captured.depegStepBps; safetyMode?: typeof captured.safetyMode } = {
      alertTypes: restoredAlertTypes,
    };
    if (captured.dewsMinBand !== null) patch.dewsMinBand = captured.dewsMinBand;
    if (captured.depegStepBps !== null) patch.depegStepBps = captured.depegStepBps;
    if (captured.safetyMode !== null) patch.safetyMode = captured.safetyMode;
    void performMutation({ kind: "set-coin", stablecoinId: captured.stablecoinId, patch });
  }, [clearUndoToast, pendingUndo, performMutation]);

  const unfollowPreset = useCallback((preset: FollowedPreset) => {
    // Presets aren't joined to subscribed coins in the current state payload, so we
    // always show the confirm sheet when the Telegram bridge exposes one (T-48).
    confirmThenFire(showConfirm, `Unfollow ${preset.label}? Direct coin settings and overlapping presets will stay unchanged.`, () => {
      void performMutation({ kind: "unfollow-preset", presetId: preset.id });
    });
  }, [performMutation, showConfirm]);

  const unsubscribeAll = useCallback(() => {
    // R3 fix: clear any pending undo before unsubscribing-all so the toast cannot
    // re-add a coin to a now-empty subscriber row.
    const fire = () => {
      clearUndoToast();
      void performMutation({ kind: "unsubscribe-all" });
    };
    confirmThenFire(showConfirm, "Unsubscribe from all alerts? This clears every coin, preset, and global toggle.", fire);
  }, [clearUndoToast, performMutation, showConfirm]);

  const forgetMe = useCallback(() => {
    // Destructive, irreversible op with no optimistic-state effect: dispatch
    // imperatively (like remove/unfollowPreset) rather than through the
    // optimistic `mutate` layer, whose React 19 transition-revert path is
    // inert here and merely inconsistent with the other danger-zone actions.
    const fire = () => void performMutation({ kind: "forget-me" });
    confirmThenFire(showConfirm, "Delete all your Pharos alert data? This cannot be undone.", () => {
      confirmThenFire(showConfirm, "Are you absolutely sure? Your subscriber row will be deleted.", fire);
    });
  }, [performMutation, showConfirm]);

  const addToHomeScreen = useCallback(() => {
    webApp?.addToHomeScreen?.();
    webApp?.HapticFeedback?.impactOccurred?.("light");
    webApp?.checkHomeScreenStatus?.((nextStatus) => {
      setHomeScreenStatus(nextStatus);
    });
  }, [webApp]);

  // Unmount cleanup for both timers owned by this hook.
  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
  }, []);

  return {
    optimisticState,
    optimisticGlobals,
    isMutating,
    pendingOperation,
    mutationRetryAfterSec,
    message,
    announcement,
    forgottenView,
    pendingUndo,
    homeScreenStatus,
    mutate,
    performMutation,
    remove,
    undoRemove,
    addToHomeScreen,
    unfollowPreset,
    unsubscribeAll,
    forgetMe,
    setMessage,
  };
}
