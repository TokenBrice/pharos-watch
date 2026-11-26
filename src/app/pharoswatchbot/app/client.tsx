"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ExternalLink, LoaderCircle } from "lucide-react";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { isPausedSentinel, isTelegramBlockedFailureClass, isTelegramSnoozeActive } from "@shared/lib/telegram-delivery-policy";
import type { MiniAppPrimaryAction, MiniAppScreenProps, TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
import { useTelegramMainButton } from "./use-telegram-main-button";
import { useTelegramBridge } from "./use-telegram-bridge";
import { useMiniAppContext } from "./use-mini-app-context";
import { useMiniAppMutations } from "./use-mini-app-mutations";
import { useMiniAppSessionLoader } from "./use-mini-app-session-loader";
import { presetLabel as presetCopyLabel } from "./constants";
import { buildPresetMemberSetById, hasAnyCoverage } from "./format";
import { PrimaryActionContext } from "./primary-action";
import { canUseTelegramPopup } from "./telegram-sdk";
import { ForgottenView } from "./components/ForgottenView";
import { PreviewState } from "./components/PreviewState";
import { MiniAppSessionStatus, type MiniAppSessionStatus as MiniAppSessionStatusValue } from "./components/MiniAppSessionStatus";
import { MiniAppHapticsContext } from "./components/List";
import { Snackbar, type SnackbarMessage } from "./components/Snackbar";
import { HomeScreen } from "./components/HomeScreen";
import { SetupScreen } from "./components/SetupScreen";
import { CoinScreen } from "./components/CoinScreen";
import { AddCoinsScreen } from "./components/AddCoinsScreen";
import { AddGroupScreen, GroupScreen } from "./components/GroupScreens";
import { SettingsScreen } from "./components/SettingsScreen";
import type { TelegramMiniAppClientSnapshot } from "./mini-app-api";
import { relaunchPayloadForScreen, useMiniAppView, type MiniAppScreen } from "./use-mini-app-view";

/** Bot DM deep link that triggers the synthetic `/sample` alert (the Mini App cannot call the Bot API). */
const BOT_DM_SAMPLE_LINK = `${TELEGRAM_BOT_URL}?start=sample`;
/** Bot DM deep link for blocked-chat 1-tap recovery (`/start status`). */
const BOT_DM_STATUS_LINK = `${TELEGRAM_BOT_URL}?start=status`;
/** Personal Mini App launch link shown inside the read-only group card. */
const PERSONAL_MINI_APP_LINK = `${TELEGRAM_BOT_URL}?startapp=home`;
/** When the tab returns to visible after being hidden longer than this, refetch the session to avoid stale state. */
const VISIBILITY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;
/** Relative ages and "today" clocks stay live while the Mini App is open, without waiting for a state change. */
const CLOCK_TICK_MS = 30 * 1000;

const EMPTY_PRESET_MEMBER_MAP: ReadonlyMap<string, ReadonlySet<string>> = new Map();

function monotonicNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

interface WriteAuthClockAnchor {
  receivedMonoMs: number;
  receivedWallMs: number;
  remainingMs: number;
}

/** No subscriber yet, or nothing followed at all: Home doubles as setup. */
function isNewUser(state: TelegramMiniAppState): boolean {
  return !state.subscriber.exists
    || (!hasAnyCoverage(state) && state.subscriptions.length === 0 && state.presets.length === 0);
}

function otherEntitySavingLabel(
  pendingOperation: TelegramMiniAppOperation | null,
  screen: MiniAppScreen,
  state: TelegramMiniAppState | null,
): string | null {
  if (!pendingOperation || !state) return null;
  if (pendingOperation.kind === "set-coin") {
    if (screen.name === "coin" && screen.coinId === pendingOperation.stablecoinId) return null;
    const symbol = state.subscriptions.find((coin) => coin.stablecoinId === pendingOperation.stablecoinId)?.symbol
      ?? state.catalog.searchableCoins.find((coin) => coin.stablecoinId === pendingOperation.stablecoinId)?.symbol
      ?? "coin";
    return `Saving ${symbol} changes…`;
  }
  if (pendingOperation.kind === "follow-preset") {
    if (screen.name === "group" && screen.groupId === pendingOperation.presetId) return null;
    const label = presetCopyLabel(
      pendingOperation.presetId,
      state.presets.find((preset) => preset.id === pendingOperation.presetId)?.label
        ?? state.catalog.recommendedPresets.find((preset) => preset.id === pendingOperation.presetId)?.label,
    );
    return `Saving ${label} changes…`;
  }
  return null;
}

export function PharosWatchBotMiniAppClient() {
  const [state, setState] = useState<TelegramMiniAppState | null>(null);
  const [stateRevision, setStateRevision] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState(false);
  const [nowSec, setNowSec] = useState(0);
  const [hasUnsavedDraft, setHasUnsavedDraft] = useState(false);
  const terminalRef = useRef(false);
  const snapshotEpochRef = useRef(0);
  const backGuardRef = useRef<((onProceed: () => void) => boolean) | null>(null);
  const lastViewerUserIdRef = useRef<string | null>(null);
  const {
    screen,
    depth,
    homeCoinsExpanded,
    setHomeCoinsExpanded,
    presetMembersExpanded,
    expandPresetMembers,
    resetExpanded,
    initializeFromStartParam,
    push,
    back,
    showSettings,
  } = useMiniAppView();
  // Session network status. The bridge hook owns the Telegram probe lifecycle; this state only
  // tracks the session fetch + the "missing launch data" terminal error after the bridge resolves.
  const [sessionStatus, setSessionStatus] = useState<MiniAppSessionStatusValue>("loading");
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [refreshedAtMs, setRefreshedAtMs] = useState<number | null>(null);
  // Telegram never refreshes initData inside a running Mini App, so a session
  // `stale-auth` is terminal: no refresh can succeed without a fresh launch.
  const [sessionAuthExpired, setSessionAuthExpired] = useState(false);
  const [clockAuthExpired, setClockAuthExpired] = useState(false);
  const [writeAuthAnchor, setWriteAuthAnchor] = useState<WriteAuthClockAnchor | null>(null);
  const [supportsV10, setSupportsV10] = useState(false);
  const [contextRefreshGeneration, setContextRefreshGeneration] = useState(0);
  const [sessionUpdateRequired, setSessionUpdateRequired] = useState(false);
  const [screenAction, setScreenAction] = useState<MiniAppPrimaryAction | null>(null);
  const [dismissedIntentId, setDismissedIntentId] = useState<number | null>(null);
  const stateRef = useRef<TelegramMiniAppState | null>(null);
  const lastHiddenAtRef = useRef<number | null>(null);

  const registerBackGuard = useCallback((guard: ((onProceed: () => void) => boolean) | null) => {
    backGuardRef.current = guard;
  }, []);

  const handleBack = useCallback(() => {
    if (terminalRef.current) return;
    if (backGuardRef.current && !backGuardRef.current(back)) return;
    back();
  }, [back]);

  const onTelegramSettings = useCallback(() => {
    if (terminalRef.current) return;
    if (backGuardRef.current && !backGuardRef.current(showSettings)) return;
    showSettings();
  }, [showSettings]);

  const readOnlyGroup = Boolean(state && state.viewer.mutationBlockReason === "not-private");

  const { webApp, initData, startParam, previewName, status: bridgeStatus } = useTelegramBridge({
    onBack: forgotten || readOnlyGroup ? undefined : handleBack,
    backButtonVisible: !forgotten && !readOnlyGroup && depth > 1,
    onSettings: forgotten || readOnlyGroup || !state ? undefined : onTelegramSettings,
  });
  const status: MiniAppSessionStatusValue = bridgeStatus === "preview"
    ? "preview"
    : bridgeStatus === "missing"
      ? "error"
      : sessionStatus;
  const sessionMessage = bridgeStatus === "missing"
    ? "Telegram didn't pass your launch details. Close and reopen from PharosWatchBot."
    : loadMessage;

  const beginSnapshotEpoch = useCallback(() => {
    snapshotEpochRef.current += 1;
    return snapshotEpochRef.current;
  }, []);

  const isCurrentSnapshotEpoch = useCallback((epoch: number) => epoch === snapshotEpochRef.current, []);

  const applyConfirmedSnapshot = useCallback((snapshot: TelegramMiniAppClientSnapshot, readEpoch?: number): boolean => {
    if (terminalRef.current) return false;
    if (readEpoch !== undefined) {
      if (readEpoch < snapshotEpochRef.current) return false;
    } else {
      snapshotEpochRef.current += 1;
      setSessionStatus("ready");
      setLoadMessage(null);
    }
    const nextUserId = snapshot.state.viewer.userId;
    if (lastViewerUserIdRef.current != null && lastViewerUserIdRef.current !== nextUserId) {
      resetExpanded();
    }
    lastViewerUserIdRef.current = nextUserId;
    stateRef.current = snapshot.state;
    setState(snapshot.state);
    setStateRevision(snapshot.stateRevision);
    setRefreshedAtMs(Date.now());
    setSupportsV10(snapshot.supportsV10 === true);
    if (readEpoch !== undefined) {
      // Explicit session read/refresh refreshes live context cache too.
      setContextRefreshGeneration((current) => current + 1);
    }
    // Track the 5-minute write window from `(mutationAuthExpiresAt - serverNowSec)`
    // using a monotonic clock anchor (null for read-only groups and legacy responses).
    const expiresAt = snapshot.state.viewer.mutationAuthExpiresAt;
    if (snapshot.serverNowSec != null && expiresAt != null) {
      const remainingSec = expiresAt - snapshot.serverNowSec;
      if (remainingSec <= 0) {
        setWriteAuthAnchor(null);
        setClockAuthExpired(true);
      } else {
        setClockAuthExpired(false);
        setWriteAuthAnchor({
          receivedMonoMs: monotonicNowMs(),
          receivedWallMs: Date.now(),
          remainingMs: remainingSec * 1000,
        });
      }
    } else if (expiresAt === null) {
      setWriteAuthAnchor(null);
      setClockAuthExpired(false);
    }
    return true;
  }, [resetExpanded]);

  const enterForgottenState = useCallback(() => {
    terminalRef.current = true;
    stateRef.current = null;
    setState(null);
    setStateRevision(null);
    setRefreshedAtMs(null);
    setWriteAuthAnchor(null);
    setClockAuthExpired(false);
    setSupportsV10(false);
    setHasUnsavedDraft(false);
    setForgotten(true);
  }, []);

  const markSessionAuthExpired = useCallback(() => setSessionAuthExpired(true), []);
  const markUpdateRequired = useCallback(() => {
    terminalRef.current = true;
    setSessionUpdateRequired(true);
  }, []);

  const loadSession = useMiniAppSessionLoader({
    terminalRef,
    stateRef,
    beginSnapshotEpoch,
    isCurrentSnapshotEpoch,
    applyConfirmedSnapshot,
    setStatus: setSessionStatus,
    setSessionMessage: setLoadMessage,
    setSessionAuthExpired,
    setUpdateRequired: markUpdateRequired,
  });

  const refreshAfterDrift = useCallback(() => {
    if (terminalRef.current || sessionUpdateRequired || sessionAuthExpired || !initData) return;
    void loadSession(initData);
  }, [initData, loadSession, sessionAuthExpired, sessionUpdateRequired]);

  const mutations = useMiniAppMutations({
    initData,
    state,
    stateRevision,
    webApp,
    onSnapshotReplaced: applyConfirmedSnapshot,
    onForgotten: enterForgottenState,
    authExpired: sessionAuthExpired || clockAuthExpired || state?.viewer.mutationBlockReason === "stale-auth",
    mutationsAllowed: status === "ready" && !sessionUpdateRequired,
    signedReadsAllowed: status === "ready" && !sessionAuthExpired && !sessionUpdateRequired,
    onSessionAuthExpired: markSessionAuthExpired,
    onRefreshSession: refreshAfterDrift,
    onUpdateRequired: markUpdateRequired,
    onWriteDispatched: beginSnapshotEpoch,
  });
  const {
    isMutating,
    pendingOperation,
    queuedOperation,
    mutationRetryAfterSec,
    notice,
    announcement,
    forgottenView,
    updateRequired: mutationUpdateRequired,
    homeScreenStatus,
    staleAuth,
    getIntendedCoinValue,
    getIntendedPresetValue,
    mutate,
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
  } = mutations;

  const updateRequired = sessionUpdateRequired || mutationUpdateRequired;

  // Single owner for closing confirmation across both in-flight mutations and unsaved drafts.
  const closingConfirmationNeeded = !forgotten && !forgottenView && !updateRequired && (isMutating || hasUnsavedDraft);
  useEffect(() => {
    if (!webApp) return;
    if (closingConfirmationNeeded) {
      webApp.enableClosingConfirmation?.();
      return () => {
        webApp.disableClosingConfirmation?.();
      };
    }
    webApp.disableClosingConfirmation?.();
    return undefined;
  }, [closingConfirmationNeeded, webApp]);

  // Escape pops the visible screen stack inside the Mini App (consistent with BackButton).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (depth <= 1 || forgotten || forgottenView || readOnlyGroup || status === "preview") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.defaultPrevented
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
      ) {
        return;
      }
      if (event.target instanceof HTMLSelectElement) return;
      if (
        event.target instanceof HTMLInputElement
        && event.target.type === "search"
        && event.target.value.length > 0
      ) {
        return;
      }
      event.preventDefault();
      handleBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [depth, forgotten, forgottenView, handleBack, readOnlyGroup, status]);

  useEffect(() => {
    let timer: number | undefined;
    const updateClock = () => {
      const nowMs = Date.now();
      const currentSec = Math.floor(nowMs / 1000);
      setNowSec(currentSec);
      const deadlines = [state?.subscriber.snoozeUntilTs, ...(state?.subscriptions.map((coin) => coin.snoozeUntilTs) ?? [])]
        .filter((ts): ts is number => ts != null && !isPausedSentinel(ts) && ts > currentSec);
      if (deadlines.length > 0) {
        timer = window.setTimeout(updateClock, Math.min(Math.min(...deadlines) * 1000 - nowMs, 2_147_483_647));
      }
    };
    updateClock();
    return () => window.clearTimeout(timer);
  }, [state]);

  // The effect above only wakes for timed snooze deadlines; keep every other
  // relative label advancing while the session stays mounted.
  useEffect(() => {
    const timer = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Kick off the initial fetch once the bridge resolves; downstream session reloads go through `loadSession`.
  // Preview and missing-launch-data outcomes are derived above, not stored.
  useEffect(() => {
    if (bridgeStatus === "loading") return;
    initializeFromStartParam(startParam);
    if (bridgeStatus === "ready" && initData) void loadSession(initData);
  }, [bridgeStatus, initData, initializeFromStartParam, loadSession, startParam]);

  // Eruda debug toggle (?debug=eruda) — dev-only; the production short-circuit and
  // dynamic-import-from-string pattern below keep the CDN URL out of the production bundle.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV === "production") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") !== "eruda") return;
    let cancelled = false;
    (async () => {
      try {
        // Magic comments: `webpackIgnore: true` covers webpack/Next dev builds, `@vite-ignore` covers Vite
        // (Turbopack honors webpackIgnore today). The `as string` cast prevents static URL analysis so
        // the bundler leaves the import as a runtime fetch instead of trying to resolve the CDN URL.
        const erudaModule = await import(/* @vite-ignore */ /* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/eruda" as string);
        if (cancelled) return;
        // Cast to unknown first because the dynamic CDN module has no static type and we only probe `init`.
        const eruda = (erudaModule as { default?: { init?: () => void } }).default ?? (erudaModule as unknown as { init?: () => void });
        eruda?.init?.();
      } catch {
        // Eruda load failed (offline, blocked CDN); fail silent.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Flip cleanly to `authExpired` (`Reopen to edit`) when the server-anchored
  // 5-minute write window elapses, re-evaluating on visibility return with no
  // noisy pre-expiry countdown banner (D1).
  useEffect(() => {
    if (!writeAuthAnchor || clockAuthExpired || forgotten || updateRequired) return undefined;
    let timer: number | undefined;
    const evaluate = () => {
      const monoElapsed = Math.max(0, monotonicNowMs() - writeAuthAnchor.receivedMonoMs);
      const wallElapsed = Math.max(0, Date.now() - writeAuthAnchor.receivedWallMs);
      const remaining = writeAuthAnchor.remainingMs - Math.max(monoElapsed, wallElapsed);
      if (remaining <= 0) {
        setClockAuthExpired(true);
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(evaluate, Math.min(remaining, 2_147_483_647));
    };
    evaluate();
    const onVisibility = () => {
      if (document.visibilityState === "visible") evaluate();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      window.clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [clockAuthExpired, forgotten, updateRequired, writeAuthAnchor]);

  // Edits expire after 5 minutes (`authExpired`), but signed reads stay valid for
  // 24h, so only a session-read `stale-auth` stops refreshing.
  const authExpired = sessionAuthExpired || clockAuthExpired || state?.viewer.mutationBlockReason === "stale-auth" || staleAuth != null;
  const triggerRefresh = useCallback(() => {
    if (forgotten || updateRequired || sessionAuthExpired || !initData || status === "loading" || isMutating) return;
    void loadSession(initData);
  }, [forgotten, initData, isMutating, loadSession, sessionAuthExpired, status, updateRequired]);

  const handleNoticeRefresh = useCallback(() => {
    dismissNotice();
    triggerRefresh();
  }, [dismissNotice, triggerRefresh]);

  // visibilitychange — refetch when returning after >10 min hidden
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState === "hidden") {
        lastHiddenAtRef.current = Date.now();
        return;
      }
      if (document.visibilityState !== "visible") return;
      const hiddenAt = lastHiddenAtRef.current;
      lastHiddenAtRef.current = null;
      if (hiddenAt == null) return;
      if (Date.now() - hiddenAt < VISIBILITY_REFRESH_THRESHOLD_MS) return;
      if (!initData) return;
      triggerRefresh();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [initData, triggerRefresh]);

  const handleClose = useCallback(() => {
    webApp?.close?.();
  }, [webApp]);

  // Sample-alert deep link: the Mini App cannot call the Bot API, so open the
  // bot DM with `?start=sample` to trigger the synthetic `/sample` preview.
  // Undefined when `openTelegramLink` is unavailable so the row stays hidden.
  const handleSendSample = useMemo(() => {
    if (!webApp?.openTelegramLink) return undefined;
    return () => {
      webApp.HapticFeedback?.impactOccurred?.("light");
      webApp.openTelegramLink?.(BOT_DM_SAMPLE_LINK);
    };
  }, [webApp]);

  // TGB-022 stale-auth recovery: Telegram never refreshes `initData` for an
  // open Mini App, so an expired 5-minute mutation window (or 24h session
  // window) requires a fresh launch. Deep-link back through `?startapp=` with the
  // visible screen so the relaunch reopens where the user left off.
  // Undefined when `openTelegramLink` is unavailable so the CTA stays hidden.
  const handleStaleAuthRelaunch = useMemo(() => {
    if (!webApp?.openTelegramLink) return undefined;
    const payload = relaunchPayloadForScreen(screen);
    return () => {
      webApp.HapticFeedback?.impactOccurred?.("light");
      webApp.openTelegramLink?.(`${TELEGRAM_BOT_URL}?startapp=${payload}`);
    };
  }, [screen, webApp]);

  // Terminal version-mismatch recovery: deep-link a fresh launch and close the outdated WebView.
  const handleUpdateReopen = useMemo(() => {
    if (!webApp?.openTelegramLink && !webApp?.close) return undefined;
    const payload = relaunchPayloadForScreen(screen);
    return () => {
      webApp.HapticFeedback?.impactOccurred?.("light");
      webApp.openTelegramLink?.(`${TELEGRAM_BOT_URL}?startapp=${payload}`);
      webApp.close?.();
    };
  }, [screen, webApp]);

  const handleOpenChat = useMemo(() => {
    if (!webApp?.openTelegramLink) return undefined;
    return () => {
      webApp.HapticFeedback?.impactOccurred?.("light");
      webApp.openTelegramLink?.(BOT_DM_STATUS_LINK);
    };
  }, [webApp]);

  const canMutate = Boolean(!forgotten && !updateRequired && !authExpired && initData && status === "ready" && state?.viewer.canMutate);
  // Expired private sessions keep edit controls live (not greyed out); the
  // mutations hook turns each attempt into visible unsaved intent instead of a request.
  const canEdit = canMutate || Boolean(!forgotten && !updateRequired && authExpired && state?.viewer.chatId != null);
  const rateLimited = mutationRetryAfterSec > 0;
  const busy = isMutating || rateLimited;
  const newUser = Boolean(state && !readOnlyGroup && isNewUser(state));
  const hasMainButton = Boolean(webApp?.MainButton);

  const { homePegContext, coinLiveContext, presetsLiveContext } = useMiniAppContext({
    enabled: Boolean(
      supportsV10
      && status === "ready"
      && initData
      && state
      && !readOnlyGroup
      && !forgotten
      && !forgottenView
      && !sessionAuthExpired
      && !updateRequired,
    ),
    initData,
    state,
    screen,
    isNewUser: newUser,
    refreshGeneration: contextRefreshGeneration,
    onSessionAuthExpired: markSessionAuthExpired,
    onUpdateRequired: markUpdateRequired,
  });

  const presetMemberSetById = useMemo(
    () => (state ? buildPresetMemberSetById(state.presets) : EMPTY_PRESET_MEMBER_MAP),
    [state],
  );

  // Exactly one primary action per state, in priority order. Screens register
  // their own (Follow, Add N coins, setup); the shell owns recovery actions.
  const primaryAction = useMemo<MiniAppPrimaryAction | null>(() => {
    if (forgotten || forgottenView) return null;
    if (updateRequired) {
      return handleUpdateReopen
        ? { kind: "reopen", text: "Reopen", onClick: handleUpdateReopen }
        : null;
    }
    if (authExpired) {
      return handleStaleAuthRelaunch
        ? {
          kind: "reopen",
          text: state?.viewer.chatId != null ? "Reopen to edit" : "Reopen Mini App",
          onClick: handleStaleAuthRelaunch,
        }
        : null;
    }
    if ((status === "error" || status === "stale") && initData) {
      return { kind: "retry", text: "Try again", onClick: () => triggerRefresh() };
    }
    if (!canMutate || !state || readOnlyGroup) return null;
    const failure = state.health.recentFailureClass;
    if (
      (screen.name === "home" || screen.name === "settings")
      && isTelegramBlockedFailureClass(failure)
      && handleOpenChat
    ) {
      return { kind: "open-chat", text: "Open PharosWatchBot chat", onClick: handleOpenChat };
    }
    if (screen.name === "home" && !newUser && isTelegramSnoozeActive(state.subscriber.snoozeUntilTs, nowSec)) {
      return {
        kind: "resume",
        text: "Resume alerts",
        progress: pendingOperation?.kind === "clear-snooze",
        onClick: () => mutate({ kind: "clear-snooze" }),
      };
    }
    return screenAction;
  }, [
    authExpired,
    canMutate,
    forgotten,
    forgottenView,
    handleOpenChat,
    handleStaleAuthRelaunch,
    handleUpdateReopen,
    initData,
    mutate,
    newUser,
    nowSec,
    pendingOperation,
    readOnlyGroup,
    screen.name,
    screenAction,
    state,
    status,
    triggerRefresh,
    updateRequired,
  ]);

  const mainButtonActive = !busy || authExpired || updateRequired;
  useTelegramMainButton({
    webApp,
    text: primaryAction?.text ?? null,
    handler: primaryAction?.onClick ?? null,
    visible: primaryAction != null,
    active: mainButtonActive,
    progress: primaryAction?.progress,
  });

  const staleIntent = staleAuth?.intent ? staleAuth : null;
  const snackbar: SnackbarMessage | null = updateRequired
    ? null
    : mutationRetryAfterSec > 0
      ? {
        key: "rate-limit",
        tone: "warning",
        live: "off",
        text: <>Too many changes in a row. Try again in <span className="pharos-numeric">{mutationRetryAfterSec}</span> s.</>,
      }
      : staleIntent && staleIntent.id !== dismissedIntentId
        ? {
          key: `stale-intent-${staleIntent.id}`,
          tone: "warning",
          text: `${staleIntent.intent} Reopen to edit.`,
          onDismiss: () => setDismissedIntentId(staleIntent.id),
        }
        : notice
          ? {
            key: notice.id,
            tone: notice.tone,
            text: notice.text,
            // Undo waits for any in-flight save rather than racing it; ambiguous write errors offer Refresh.
            action: notice.undoLabel
              ? { label: notice.undoLabel, onClick: undo, disabled: isMutating }
              : notice.refreshAction && initData && !sessionAuthExpired
                ? { label: "Refresh", onClick: handleNoticeRefresh, disabled: isMutating || status === "loading" }
                : undefined,
            onDismiss: dismissNotice,
          }
          : null;

  if (status === "preview") return <PreviewState previewName={previewName} startParam={startParam} />;
  if (forgottenView) return <ForgottenView onClose={webApp?.close ? handleClose : undefined} />;

  const openPrivacy = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (webApp?.openLink) {
      event.preventDefault();
      webApp.openLink(`${typeof window === "undefined" ? "" : window.location.origin}/privacy`);
    }
  };

  const screenProps: MiniAppScreenProps | null = state ? {
    state,
    nowSec,
    canEdit,
    busy,
    rateLimited,
    pendingOperation,
    queuedOperation,
    getIntendedCoinValue,
    getIntendedPresetValue,
    presetMemberSetById,
    onMutate: mutate,
  } : null;

  const otherEntitySavingCue = isMutating && !updateRequired
    ? otherEntitySavingLabel(pendingOperation, screen, state)
    : null;

  const renderScreen = () => {
    if (!screenProps || !state) return null;
    if (readOnlyGroup) {
      return (
        <section className="rounded-xl bg-[var(--mini-card)] px-4 py-4">
          <h1 tabIndex={-1} className="outline-none text-base font-semibold text-foreground">
            Group alerts are managed in the group
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Send <code className="pharos-numeric rounded-sm bg-muted px-1 py-0.5 text-xs text-foreground">/settings@PharosWatchBot</code> in the group chat. Only group admins can change its alerts.
          </p>
          <div className="mt-3 -ml-2">
            {webApp?.openTelegramLink ? (
              <button
                type="button"
                onClick={() => webApp.openTelegramLink?.(PERSONAL_MINI_APP_LINK)}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-[color:var(--telegram-link,var(--mini-accent))] active:opacity-70"
              >
                Open your personal alerts
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : (
              <a
                href={PERSONAL_MINI_APP_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-[color:var(--telegram-link,var(--mini-accent))]"
              >
                Open your personal alerts
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
          </div>
        </section>
      );
    }
    switch (screen.name) {
      case "home":
        return newUser
          ? <SetupScreen {...screenProps} push={push} />
          : (
            <HomeScreen
              {...screenProps}
              push={push}
              webApp={webApp}
              primaryActionKind={primaryAction?.kind ?? null}
              hasMainButton={hasMainButton}
              coinsExpanded={homeCoinsExpanded}
              onExpandCoins={() => setHomeCoinsExpanded(true)}
              homePegContext={homePegContext}
            />
          );
      case "coin":
        return (
          <CoinScreen
            {...screenProps}
            coinId={screen.coinId}
            webApp={webApp}
            push={push}
            liveContext={coinLiveContext}
            onRemove={(coin, coveredBySource) => void remove(coin, coveredBySource).then((removed) => { if (removed) back(); })}
          />
        );
      case "add-coins":
        return (
          <AddCoinsScreen
            {...screenProps}
            webApp={webApp}
            hasInlineBack={depth > 1 && !webApp?.BackButton && !readOnlyGroup}
            onApply={applyBulkWatchlist}
            onDone={back}
            onDirtyChange={setHasUnsavedDraft}
            registerBackGuard={registerBackGuard}
          />
        );
      case "group":
        return (
          <GroupScreen
            {...screenProps}
            groupId={screen.groupId}
            webApp={webApp}
            push={push}
            membersExpanded={Boolean(presetMembersExpanded[screen.groupId])}
            onExpandMembers={() => expandPresetMembers(screen.groupId)}
            onUnfollow={(preset) => void unfollowPreset(preset).then((unfollowed) => { if (unfollowed) back(); })}
          />
        );
      case "add-group":
        return <AddGroupScreen state={state} push={push} presetsLiveContext={presetsLiveContext} />;
      case "settings":
        return (
          <SettingsScreen
            {...screenProps}
            onPause={pause}
            onSendSample={handleSendSample}
            onAddToHomeScreen={homeScreenStatus === "missed" ? addToHomeScreen : undefined}
            onUnsubscribeAll={unsubscribeAll}
            onForgetMe={forgetMe}
            hasShowConfirm={Boolean(webApp?.showConfirm)}
            hasForgetConfirm={Boolean(canUseTelegramPopup(webApp) || webApp?.showConfirm)}
            onInvalid={showError}
          />
        );
    }
  };

  const showInlineFallbackCta = !hasMainButton
    && primaryAction != null
    && primaryAction.kind !== "reopen"
    && primaryAction.kind !== "retry"
    && primaryAction.kind !== "resume";
  const showPrivacyFooter = !readOnlyGroup
    && (screen.name === "settings" || (screen.name === "home" && newUser));

  return (
    <MiniAppHapticsContext.Provider value={webApp?.HapticFeedback ?? null}>
      <PrimaryActionContext.Provider value={setScreenAction}>
        <section className="pharos-mini-app min-h-[max(var(--telegram-viewport-height,100svh),100svh)] bg-[var(--mini-panel)] text-[var(--telegram-text,var(--foreground))]">
          <div className="mx-auto flex max-w-lg flex-col pt-[calc(var(--mini-safe-top)+0.75rem)] pb-[calc(var(--mini-safe-bottom)+6rem)] pl-[calc(var(--mini-safe-left)+0.75rem)] pr-[calc(var(--mini-safe-right)+0.75rem)] sm:pl-[calc(var(--mini-safe-left)+1rem)] sm:pr-[calc(var(--mini-safe-right)+1rem)]">
            <span className="sr-only" aria-live="polite">{announcement}</span>

            <MiniAppSessionStatus
              status={status}
              screenName={screen.name}
              hasDisplayState={Boolean(state)}
              refreshedAtMs={refreshedAtMs}
              message={sessionMessage}
              canClose={Boolean(webApp?.close)}
              retryAvailable={Boolean(initData) && !sessionAuthExpired && !updateRequired}
              relaunchInMainButton={hasMainButton && primaryAction?.kind === "reopen"}
              updateRequired={updateRequired}
              staleAuth={authExpired ? { sessionExpired: sessionAuthExpired } : null}
              onClose={handleClose}
              // The native MainButton carries these actions; render them inline only without one.
              onRetry={hasMainButton || !initData || sessionAuthExpired || updateRequired ? undefined : triggerRefresh}
              onStaleAuthRelaunch={hasMainButton ? undefined : handleStaleAuthRelaunch}
              onUpdateReopen={hasMainButton ? undefined : handleUpdateReopen}
            />

            {otherEntitySavingCue ? (
              <div
                role="status"
                aria-live="polite"
                className="mb-3 flex items-center gap-2 rounded-xl bg-[var(--mini-card)] px-3.5 py-2 text-xs text-muted-foreground"
              >
                <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />
                <span>{otherEntitySavingCue}</span>
              </div>
            ) : null}

            {state ? (
              <>
                {depth > 1 && !webApp?.BackButton && !readOnlyGroup ? (
                  <div className="mb-1">
                    <button
                      type="button"
                      onClick={handleBack}
                      className="pharos-focus-ring -ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-[color:var(--telegram-link,var(--mini-accent))] active:opacity-70"
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                      Back
                    </button>
                  </div>
                ) : null}
                {renderScreen()}
                {showInlineFallbackCta ? (
                  <button
                    type="button"
                    onClick={primaryAction.onClick}
                    disabled={busy}
                    aria-busy={primaryAction.progress || undefined}
                    className="pharos-focus-ring mt-6 min-h-12 w-full rounded-xl bg-[var(--telegram-button,var(--mini-accent))] px-4 text-base font-semibold text-[color:var(--telegram-button-text,white)] disabled:opacity-50"
                  >
                    {primaryAction.text}
                  </button>
                ) : null}
                {showPrivacyFooter ? (
                  <p className="mt-8 px-4 text-center text-xs leading-relaxed text-muted-foreground">
                    Pharos stores your Telegram user ID and chat ID to deliver alerts.
                    {" "}
                    <a href="/privacy" target="_blank" rel="noopener noreferrer" onClick={openPrivacy} className="pharos-focus-ring -my-3 inline-block py-3 underline">What we keep</a>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          <Snackbar message={snackbar} mainButtonVisible={hasMainButton && primaryAction != null} />
        </section>
      </PrimaryActionContext.Provider>
    </MiniAppHapticsContext.Provider>
  );
}
