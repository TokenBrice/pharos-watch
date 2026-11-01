"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { isPausedSentinel, isTelegramSnoozeActive } from "@shared/lib/telegram-delivery-policy";
import type { MiniAppPrimaryAction, MiniAppScreenProps, TelegramMiniAppState } from "./types";
import { useTelegramMainButton } from "./use-telegram-main-button";
import { useTelegramBridge } from "./use-telegram-bridge";
import { useMiniAppMutations } from "./use-mini-app-mutations";
import { useMiniAppSessionLoader } from "./use-mini-app-session-loader";
import { hasAnyCoverage } from "./format";
import { PrimaryActionContext } from "./primary-action";
import { ForgottenView } from "./components/ForgottenView";
import { PreviewState } from "./components/PreviewState";
import { MiniAppSessionStatus, type MiniAppSessionStatus as MiniAppSessionStatusValue } from "./components/MiniAppSessionStatus";
import { Snackbar, type SnackbarMessage } from "./components/Snackbar";
import { HomeScreen } from "./components/HomeScreen";
import { SetupScreen } from "./components/SetupScreen";
import { CoinScreen } from "./components/CoinScreen";
import { AddCoinsScreen } from "./components/AddCoinsScreen";
import { AddGroupScreen, GroupScreen } from "./components/GroupScreens";
import { SettingsScreen } from "./components/SettingsScreen";
import type { TelegramMiniAppClientSnapshot } from "./mini-app-api";
import { relaunchPayloadForScreen, useMiniAppView } from "./use-mini-app-view";

/** Bot DM deep link that triggers the synthetic `/sample` alert (the Mini App cannot call the Bot API). */
const BOT_DM_SAMPLE_LINK = `${TELEGRAM_BOT_URL}?start=sample`;
/** When the tab returns to visible after being hidden longer than this, refetch the session to avoid stale state. */
const VISIBILITY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;
/** Relative ages and "today" clocks stay live while the Mini App is open, without waiting for a state change. */
const CLOCK_TICK_MS = 30 * 1000;

/** No subscriber yet, or nothing followed at all: Home doubles as setup. */
function isNewUser(state: TelegramMiniAppState): boolean {
  return !state.subscriber.exists
    || (!hasAnyCoverage(state) && state.subscriptions.length === 0 && state.presets.length === 0);
}

export function PharosWatchBotMiniAppClient() {
  const [state, setState] = useState<TelegramMiniAppState | null>(null);
  const [forgotten, setForgotten] = useState(false);
  const [nowSec, setNowSec] = useState(0);
  const terminalRef = useRef(false);
  const { screen, depth, initializeFromStartParam, push, back, showSettings } = useMiniAppView();
  // Session network status. The bridge hook owns the Telegram probe lifecycle; this state only
  // tracks the session fetch + the "missing launch data" terminal error after the bridge resolves.
  const [sessionStatus, setSessionStatus] = useState<MiniAppSessionStatusValue>("loading");
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [refreshedAtMs, setRefreshedAtMs] = useState<number | null>(null);
  // Telegram never refreshes initData inside a running Mini App, so a session
  // `stale-auth` is terminal: no refresh can succeed without a fresh launch.
  const [sessionAuthExpired, setSessionAuthExpired] = useState(false);
  const [screenAction, setScreenAction] = useState<MiniAppPrimaryAction | null>(null);
  const [dismissedIntent, setDismissedIntent] = useState<string | null>(null);
  const stateRef = useRef<TelegramMiniAppState | null>(null);
  const lastHiddenAtRef = useRef<number | null>(null);

  const onTelegramBack = useCallback(() => {
    if (!terminalRef.current) back();
  }, [back]);
  const onTelegramSettings = useCallback(() => {
    if (!terminalRef.current) showSettings();
  }, [showSettings]);
  const { webApp, initData, startParam, previewName, status: bridgeStatus } = useTelegramBridge({
    onBack: forgotten ? undefined : onTelegramBack,
    backButtonVisible: !forgotten && depth > 1,
    onSettings: forgotten ? undefined : onTelegramSettings,
  });
  const status: MiniAppSessionStatusValue = bridgeStatus === "preview"
    ? "preview"
    : bridgeStatus === "missing"
      ? "error"
      : sessionStatus;
  const sessionMessage = bridgeStatus === "missing"
    ? "Telegram didn't pass your launch details. Close and reopen from PharosWatchBot."
    : loadMessage;

  const applyConfirmedSnapshot = useCallback((snapshot: TelegramMiniAppClientSnapshot) => {
    if (terminalRef.current) return;
    stateRef.current = snapshot.state;
    setState(snapshot.state);
    setRefreshedAtMs(Date.now());
  }, []);

  const enterForgottenState = useCallback(() => {
    terminalRef.current = true;
    stateRef.current = null;
    setState(null);
    setRefreshedAtMs(null);
    setForgotten(true);
  }, []);

  const markSessionAuthExpired = useCallback(() => setSessionAuthExpired(true), []);

  const mutations = useMiniAppMutations({
    initData,
    state,
    webApp,
    onSnapshotReplaced: applyConfirmedSnapshot,
    onForgotten: enterForgottenState,
    authExpired: sessionAuthExpired || state?.viewer.mutationBlockReason === "stale-auth",
    mutationsAllowed: status === "ready",
    signedReadsAllowed: status === "ready" && !sessionAuthExpired,
    onSessionAuthExpired: markSessionAuthExpired,
  });
  const {
    isMutating,
    pendingOperation,
    mutationRetryAfterSec,
    notice,
    announcement,
    forgottenView,
    homeScreenStatus,
    staleAuth,
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

  const loadSession = useMiniAppSessionLoader({
    terminalRef,
    stateRef,
    applyConfirmedSnapshot,
    setStatus: setSessionStatus,
    setSessionMessage: setLoadMessage,
    setSessionAuthExpired,
  });

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

  // Edits expire after 5 minutes (`authExpired`), but signed reads stay valid for
  // 24h, so only a session-read `stale-auth` stops refreshing.
  const authExpired = sessionAuthExpired || state?.viewer.mutationBlockReason === "stale-auth" || staleAuth != null;
  const triggerRefresh = useCallback(() => {
    if (forgotten || sessionAuthExpired || !initData || status === "loading" || isMutating) return;
    void loadSession(initData);
  }, [forgotten, initData, isMutating, loadSession, sessionAuthExpired, status]);

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

  const handleOpenChat = useMemo(() => {
    if (!webApp?.openTelegramLink) return undefined;
    return () => webApp.openTelegramLink?.(TELEGRAM_BOT_URL);
  }, [webApp]);

  const canMutate = Boolean(!forgotten && initData && status === "ready" && state?.viewer.canMutate);
  // Expired private sessions keep edit controls live (not greyed out); the
  // mutations hook turns each attempt into visible unsaved intent instead of a request.
  const canEdit = canMutate || Boolean(!forgotten && authExpired && state?.viewer.chatId != null);
  const busy = isMutating || mutationRetryAfterSec > 0;
  const readOnlyGroup = Boolean(state && state.viewer.mutationBlockReason === "not-private");
  const newUser = Boolean(state && !readOnlyGroup && isNewUser(state));
  const hasMainButton = Boolean(webApp?.MainButton);

  // Exactly one primary action per state, in priority order. Screens register
  // their own (Follow, Add N coins, setup); the shell owns recovery actions.
  const primaryAction = useMemo<MiniAppPrimaryAction | null>(() => {
    if (forgotten || forgottenView) return null;
    if (authExpired) {
      return handleStaleAuthRelaunch
        ? { text: state?.viewer.chatId != null ? "Reopen to edit" : "Reopen Mini App", onClick: handleStaleAuthRelaunch }
        : null;
    }
    if ((status === "error" || status === "stale") && initData) return { text: "Try again", onClick: () => triggerRefresh() };
    if (!canMutate || !state) return null;
    if (screen.name === "home" && !newUser) {
      const failure = state.health.recentFailureClass;
      if ((failure === "blocked" || failure === "forbidden") && handleOpenChat) {
        return { text: "Open chat with PharosWatchBot", onClick: handleOpenChat };
      }
      if (isTelegramSnoozeActive(state.subscriber.snoozeUntilTs, nowSec)) {
        return {
          text: "Resume alerts",
          progress: pendingOperation?.kind === "clear-snooze",
          onClick: () => mutate({ kind: "clear-snooze" }),
        };
      }
    }
    return screenAction;
  }, [authExpired, canMutate, forgotten, forgottenView, handleOpenChat, handleStaleAuthRelaunch, initData, mutate, newUser, nowSec, pendingOperation, screen.name, screenAction, state, status, triggerRefresh]);

  const mainButtonActive = !busy || authExpired;
  useTelegramMainButton({
    webApp,
    text: primaryAction?.text ?? null,
    handler: primaryAction?.onClick ?? null,
    visible: primaryAction != null,
    active: mainButtonActive,
    progress: primaryAction?.progress,
  });

  const intent = staleAuth?.intent ?? null;
  const snackbar: SnackbarMessage | null = mutationRetryAfterSec > 0
    ? { key: "rate-limit", tone: "warning", text: `Too many changes in a row. Try again in ${mutationRetryAfterSec} s.` }
    : intent && intent !== dismissedIntent
      ? { key: intent, tone: "warning", text: `${intent} Reopen to edit.`, onDismiss: () => setDismissedIntent(intent) }
      : notice
        ? {
          key: notice.id,
          tone: notice.tone,
          text: notice.text,
          // Undo waits for any in-flight save rather than racing it.
          action: notice.undoLabel ? { label: notice.undoLabel, onClick: undo, disabled: isMutating } : undefined,
          onDismiss: dismissNotice,
        }
        : null;

  if (status === "preview") return <PreviewState previewName={previewName} />;
  if (forgottenView) return <ForgottenView onClose={handleClose} />;

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
    pendingOperation,
    onMutate: mutate,
  } : null;

  const renderScreen = () => {
    if (!screenProps || !state) return null;
    if (readOnlyGroup) {
      return (
        <section className="rounded-xl bg-[var(--mini-card)] px-4 py-4">
          <h1 className="text-base font-semibold text-foreground">Group alerts are managed in the group</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Send <code className="pharos-numeric rounded-sm bg-muted px-1 py-0.5 text-xs text-foreground">/settings@PharosWatchBot</code> in the group chat. Only group admins can change its alerts.
          </p>
        </section>
      );
    }
    switch (screen.name) {
      case "home":
        return newUser
          ? <SetupScreen {...screenProps} push={push} onSendSample={handleSendSample} />
          : <HomeScreen {...screenProps} push={push} onPause={pause} showInlineResume={!hasMainButton} />;
      case "coin":
        return <CoinScreen {...screenProps} coinId={screen.coinId} webApp={webApp} onRemove={(coin) => void remove(coin).then((removed) => { if (removed) back(); })} />;
      case "add-coins":
        return <AddCoinsScreen {...screenProps} onApply={applyBulkWatchlist} onDone={back} />;
      case "group":
        return <GroupScreen {...screenProps} groupId={screen.groupId} onUnfollow={(preset) => void unfollowPreset(preset).then((unfollowed) => { if (unfollowed) back(); })} />;
      case "add-group":
        return <AddGroupScreen state={state} push={push} />;
      case "settings":
        return (
          <SettingsScreen
            {...screenProps}
            onSendSample={handleSendSample}
            onAddToHomeScreen={homeScreenStatus === "missed" ? addToHomeScreen : undefined}
            onUnsubscribeAll={unsubscribeAll}
            onForgetMe={forgetMe}
            hasShowConfirm={Boolean(webApp?.showConfirm)}
            onInvalid={showError}
          />
        );
    }
  };

  return (
    <PrimaryActionContext.Provider value={setScreenAction}>
      <section className="pharos-mini-app min-h-[max(var(--telegram-viewport-height,100svh),100svh)] bg-[var(--mini-panel)] text-[var(--telegram-text,var(--foreground))]">
        <div className="mx-auto flex max-w-2xl flex-col px-3 pt-[calc(env(safe-area-inset-top)+var(--telegram-safe-area-top,0px)+0.75rem)] pb-[calc(env(safe-area-inset-bottom)+var(--telegram-safe-area-bottom,0px)+6rem)] sm:px-4">
          <span className="sr-only" aria-live="polite">{announcement}</span>

          <MiniAppSessionStatus
            status={status}
            hasDisplayState={Boolean(state)}
            refreshedAtMs={refreshedAtMs}
            message={sessionMessage}
            canClose={Boolean(webApp?.close)}
            retryAvailable={Boolean(initData) && !sessionAuthExpired}
            staleAuth={authExpired ? { sessionExpired: sessionAuthExpired } : null}
            onClose={handleClose}
            // The native MainButton carries these actions; render them inline only without one.
            onRetry={hasMainButton || !initData || sessionAuthExpired ? undefined : triggerRefresh}
            onStaleAuthRelaunch={hasMainButton ? undefined : handleStaleAuthRelaunch}
          />

          {state ? (
            <>
              {renderScreen()}
              {!hasMainButton && screenAction && primaryAction === screenAction ? (
                <button
                  type="button"
                  onClick={screenAction.onClick}
                  disabled={busy}
                  aria-busy={screenAction.progress || undefined}
                  className="pharos-focus-ring mt-6 min-h-12 w-full rounded-xl bg-[var(--telegram-button,var(--mini-accent))] px-4 text-base font-semibold text-[color:var(--telegram-button-text,white)] disabled:opacity-50"
                >
                  {screenAction.text}
                </button>
              ) : null}
              <p className="mt-8 px-4 text-center text-xs leading-relaxed text-muted-foreground">
                Pharos stores your Telegram user ID and chat ID to deliver alerts.
                {" "}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" onClick={openPrivacy} className="pharos-focus-ring -my-3 inline-block py-3 underline">What we keep</a>
              </p>
            </>
          ) : null}
        </div>
        <Snackbar message={snackbar} />
      </section>
    </PrimaryActionContext.Provider>
  );
}
