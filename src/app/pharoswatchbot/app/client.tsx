"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { TelegramAlertType, TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
import { useTelegramMainButton } from "./use-telegram-main-button";
import { useTelegramBridge } from "./use-telegram-bridge";
import { useMiniAppMutations } from "./use-mini-app-mutations";
import { miniAppErrorMessage } from "./error-messages";
import { MiniButton } from "./components/MiniButton";
import { HomeSkeleton } from "./components/HomeSkeleton";
import { ForgottenView } from "./components/ForgottenView";
import { PreviewState } from "./components/PreviewState";
import { STALE_AUTH_READ_ONLY_COPY, StatusPanel } from "./components/StatusPanel";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { CoinInsightPanel } from "./components/CoinInsightPanel";
import { PresetsPanel } from "./components/PresetsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { MiniAppTabs } from "./components/MiniAppTabs";
import { ALERT_LABELS, RECOMMENDED_OPERATION } from "./constants";
import { isPausedSentinel } from "./format";
import {
  isMiniAppVersionMismatch,
  postMiniAppSnapshot,
  refreshMiniAppBundleOnce,
  type TelegramMiniAppClientSnapshot,
} from "./mini-app-api";
import { relaunchPayloadForView, useMiniAppView, type ViewKey } from "./use-mini-app-view";

const SESSION_ENDPOINT = API_PATHS.telegramMiniAppSession();
const BOT_URL = "https://t.me/PharosWatchBot";
/** Bot DM deep link that triggers the synthetic `/sample` alert (the Mini App cannot call the Bot API). */
const BOT_DM_SAMPLE_LINK = "https://t.me/PharosWatchBot?start=sample";
/** When the tab returns to visible after being hidden longer than this, refetch the session to avoid stale state. */
const VISIBILITY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

export function PharosWatchBotMiniAppClient() {
  const [state, setState] = useState<TelegramMiniAppState | null>(null);
  const {
    view,
    coinInsightTarget,
    highlightedCoinId,
    visibleCoinTarget,
    backButtonVisible,
    initializeFromStartParam,
    handleBack: handleTelegramBack,
    showSettings: handleTelegramSettings,
    activateView: setActiveView,
    setCoinInsightTarget,
    setCoinTarget,
  } = useMiniAppView(state);
  // Session network status. The bridge hook owns the Telegram probe lifecycle; this state only
  // tracks the session fetch + the "missing launch data" terminal error after the bridge resolves.
  const [status, setStatus] = useState<"preview" | "loading" | "ready" | "stale" | "error">("loading");
  const [confirmedMeta, setConfirmedMeta] = useState<{ revision: string; refreshedAtMs: number } | null>(null);
  const stateRef = useRef<TelegramMiniAppState | null>(null);
  const lastHiddenAtRef = useRef<number | null>(null);
  const mainButtonInFlightRef = useRef(false);
  // Forward-ref to `loadSession` so the mutations hook can call back for stale-auth recovery
  // even though `loadSession` is defined later (it depends on the hook's `setMessage`).
  const loadSessionRef = useRef<((nextInitData: string, options?: { clearMessage?: boolean }) => Promise<void>) | null>(null);

  const { webApp, initData, startParam, previewName, status: bridgeStatus } = useTelegramBridge({
    onBack: handleTelegramBack,
    backButtonVisible,
    onSettings: handleTelegramSettings,
  });

  const reloadSession = useCallback(async (options?: { clearMessage?: boolean }) => {
    const fn = loadSessionRef.current;
    if (fn && initData) await fn(initData, options);
  }, [initData]);

  const applyConfirmedSnapshot = useCallback((snapshot: TelegramMiniAppClientSnapshot) => {
    stateRef.current = snapshot.state;
    setState(snapshot.state);
    setConfirmedMeta({ revision: snapshot.stateRevision, refreshedAtMs: Date.now() });
  }, []);

  const mutations = useMiniAppMutations({
    initData,
    state,
    webApp,
    onSnapshotReplaced: applyConfirmedSnapshot,
    reloadSession,
    messageAutoDismissActive: status === "ready",
    mutationsAllowed: status === "ready",
  });
  const {
    displayState,
    confirmedGlobals,
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
    remove: handleRemoveCoin,
    undoRemove: handleUndoRemove,
    addToHomeScreen: handleAddToHomeScreen,
    unfollowPreset: handleUnfollowPreset,
    unsubscribeAll: handleUnsubscribeAll,
    forgetMe: handleForgetMe,
    setMessage,
  } = mutations;

  const loadSession = useCallback(async (nextInitData: string, options: { clearMessage?: boolean } = {}) => {
    setStatus("loading");
    try {
      applyConfirmedSnapshot(await postMiniAppSnapshot(SESSION_ENDPOINT, { initData: nextInitData }));
      setStatus("ready");
      if (options.clearMessage !== false) setMessage(null);
    } catch (err) {
      if (isMiniAppVersionMismatch(err) && refreshMiniAppBundleOnce({
        contractVersion: err.serverContractVersion,
        catalogVersion: err.serverCatalogVersion,
      })) {
        return;
      }
      setStatus(stateRef.current ? "stale" : "error");
      setMessage(miniAppErrorMessage(err, "session"));
    }
  }, [applyConfirmedSnapshot, setMessage]);
  useEffect(() => { loadSessionRef.current = loadSession; }, [loadSession]);

  const headline = useMemo(() => {
    if (!displayState) return "";
    const activeGlobalCount = (Object.keys(ALERT_LABELS) as TelegramAlertType[]).filter((type) => displayState.subscriber.globalAlerts[type]).length;
    const presetCount = displayState.presets.length;
    const presetClause = presetCount > 0 ? `, ${presetCount} presets` : "";
    return `${activeGlobalCount} global alert families, ${displayState.subscriptions.length} explicit coins${presetClause}.`;
  }, [displayState]);

  // Translate bridge resolution into our session-level status and kick off the initial fetch.
  // Runs once per bridge-status transition; downstream session reloads go through `loadSession`.
  useEffect(() => {
    if (bridgeStatus === "loading") return;
    initializeFromStartParam(startParam);
    if (bridgeStatus === "preview") {
      setStatus("preview");
      return;
    }
    if (bridgeStatus === "missing") {
      setStatus("error");
      setMessage("Telegram launch data was not available. Close and reopen from PharosWatchBot.");
      return;
    }
    // bridgeStatus === "ready"
    if (initData) void loadSession(initData);
  }, [bridgeStatus, initData, initializeFromStartParam, loadSession, setMessage, startParam]);

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

  const triggerRefresh = useCallback(() => {
    if (!initData || status === "loading" || isMutating) return;
    void loadSession(initData);
  }, [initData, isMutating, loadSession, status]);

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
  // Undefined when `openTelegramLink` is unavailable so the CTA stays hidden.
  const handleSendSample = useMemo(() => {
    if (!webApp?.openTelegramLink) return undefined;
    return () => {
      webApp.HapticFeedback?.impactOccurred?.("light");
      webApp.openTelegramLink?.(BOT_DM_SAMPLE_LINK);
    };
  }, [webApp]);

  // TGB-022 stale-auth recovery: Telegram never refreshes `initData` for an
  // open Mini App, so an expired 5-minute mutation window requires a fresh
  // launch. Deep-link back through `?startapp=` with the current panel (and
  // coin/insight context) so the relaunch reopens where the user left off.
  // Undefined when `openTelegramLink` is unavailable so the CTA stays hidden.
  const handleStaleAuthRelaunch = useMemo(() => {
    if (!webApp?.openTelegramLink) return undefined;
    const payload = relaunchPayloadForView(view, coinInsightTarget, visibleCoinTarget);
    return () => {
      webApp.HapticFeedback?.impactOccurred?.("light");
      webApp.openTelegramLink?.(`${BOT_URL}?startapp=${payload}`);
    };
  }, [coinInsightTarget, view, visibleCoinTarget, webApp]);

  // MainButton — derive `text` and `handler` from the current view/state and
  // delegate the Telegram lifecycle (attach/detach, setParams, show/hide) to
  // the shared hook. See `use-telegram-main-button.ts` for the cleanup contract.
  const canMutate = Boolean(initData && status === "ready" && state?.viewer.canMutate);
  const mutationControlsDisabled = isMutating || mutationRetryAfterSec > 0;
  const runMainButtonMutation = useCallback((operation: TelegramMiniAppOperation) => {
    if (!canMutate || mutationControlsDisabled || mainButtonInFlightRef.current) return;
    mainButtonInFlightRef.current = true;
    void performMutation(operation).finally(() => {
      mainButtonInFlightRef.current = false;
    });
  }, [canMutate, mutationControlsDisabled, performMutation]);

  const { text: mainButtonText, handler: mainButtonHandler } = useMemo<{ text: string | null; handler: (() => void) | null }>(() => {
    if (!canMutate || mutationControlsDisabled) return { text: null, handler: null };
    if (view === "home") {
      if (displayState && !displayState.subscriber.exists) {
        return { text: "Use recommended setup", handler: () => runMainButtonMutation(RECOMMENDED_OPERATION) };
      }
      if (displayState?.subscriber.snoozeUntilTs != null) {
        const label = isPausedSentinel(displayState.subscriber.snoozeUntilTs) ? "Resume alerts" : "Clear snooze";
        return { text: label, handler: () => runMainButtonMutation({ kind: "clear-snooze" }) };
      }
    }
    return { text: null, handler: null };
  }, [canMutate, displayState, mutationControlsDisabled, runMainButtonMutation, view]);
  useTelegramMainButton({
    webApp,
    text: mainButtonText,
    handler: mainButtonHandler,
    visible: Boolean(mainButtonText && mainButtonHandler && canMutate && !mutationControlsDisabled),
    active: canMutate && !mutationControlsDisabled,
  });

  if (status === "preview") return <PreviewState previewName={previewName} />;
  if (forgottenView) return <ForgottenView onClose={handleClose} />;

  const heading = state?.viewer.username
    ? `@${state.viewer.username}`
    : state?.viewer.firstName ?? "PharosWatchBot";
  const showStaleAuthBanner = displayState?.viewer.mutationBlockReason === "stale-auth";
  const nowSec = Math.floor(Date.now() / 1000);

  const openPrivacy = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (webApp?.openLink) {
      event.preventDefault();
      webApp.openLink(`${typeof window === "undefined" ? "" : window.location.origin}/privacy`);
    }
  };

  const activateView = (key: ViewKey) => {
    setActiveView(key);
    webApp?.HapticFeedback?.selectionChanged?.();
  };

  return (
    <section className="pharos-mini-app min-h-[max(var(--telegram-viewport-height,100svh),100svh)] [overflow-wrap:anywhere] bg-[var(--telegram-bg,var(--background))] text-[var(--telegram-text,var(--foreground))]">
      <div className="mx-auto flex max-w-2xl flex-col px-3 pb-[calc(env(safe-area-inset-bottom)+var(--telegram-safe-area-bottom,0px)+1rem)] sm:px-4">
        <div className="sticky top-0 z-20 -mx-3 border-b border-border/60 bg-[var(--telegram-bg,var(--background))] px-3 pb-3 pt-[calc(env(safe-area-inset-top)+var(--telegram-safe-area-top,0px)+0.5rem)] sm:-mx-4 sm:px-4">
          <header className="flex items-center justify-between gap-3 pb-2">
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-foreground">{heading}</h1>
            <button
              type="button"
              aria-label="Refresh session"
              disabled={!initData || status === "loading" || isMutating}
              onClick={triggerRefresh}
              className="pharos-focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/65 bg-background/60 text-foreground transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={cn("h-4 w-4", status === "loading" && "animate-spin")} aria-hidden="true" />
            </button>
          </header>
          {displayState ? (
            <MiniAppTabs view={view} onActivate={activateView} />
          ) : null}
        </div>
        <span className="sr-only" aria-live="polite">{announcement}</span>

        {status === "loading" && !displayState ? <HomeSkeleton /> : null}
        {status === "loading" && displayState ? <p className="sr-only" aria-live="polite">Refreshing settings. Editing is temporarily unavailable.</p> : null}
        {status === "stale" && displayState && confirmedMeta ? (
          <section role="status" aria-live="polite" className="mt-4 rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4">
            <div className="flex gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-foreground">Showing last-known settings</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {message} Editing is read-only until Refresh succeeds.
                </p>
                <dl className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                  <div className="flex min-w-0 gap-2">
                    <dt className="font-semibold text-foreground">Revision</dt>
                    <dd className="min-w-0 break-all font-mono">{confirmedMeta.revision}</dd>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <dt className="font-semibold text-foreground">Refreshed</dt>
                    <dd>
                      <time dateTime={new Date(confirmedMeta.refreshedAtMs).toISOString()}>
                        {new Date(confirmedMeta.refreshedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </time>
                    </dd>
                  </div>
                </dl>
                <div className="mt-3">
                  <MiniButton variant="secondary" onClick={triggerRefresh}>Retry refresh</MiniButton>
                </div>
              </div>
            </div>
          </section>
        ) : null}
        {status === "error" ? (
          <section role="alert" className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">{message}</p>
            <div className="mt-3">
              {initData ? (
                <MiniButton variant="secondary" onClick={triggerRefresh}>Retry</MiniButton>
              ) : webApp?.close ? (
                <MiniButton variant="secondary" onClick={handleClose}>Close and reopen</MiniButton>
              ) : (
                <Button asChild variant="outline" className="gap-2">
                  <a href={BOT_URL} target="_blank" rel="noopener noreferrer">
                    Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  </a>
                </Button>
              )}
            </div>
          </section>
        ) : null}
        {message && status === "ready" ? <section role="status" className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">{message}</section> : null}
        {mutationRetryAfterSec > 0 && status === "ready" ? (
          <section
            role="timer"
            aria-live="off"
            aria-atomic="true"
            className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground"
          >
            Pharos edit limit reached. Settings unlock in {mutationRetryAfterSec} {mutationRetryAfterSec === 1 ? "second" : "seconds"}.
          </section>
        ) : null}
        {showStaleAuthBanner ? (
          <section className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-semibold text-foreground">{STALE_AUTH_READ_ONLY_COPY.title}</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{STALE_AUTH_READ_ONLY_COPY.body}</p>
                {handleStaleAuthRelaunch ? (
                  <div className="mt-3">
                    <MiniButton variant="secondary" onClick={handleStaleAuthRelaunch}>
                      Relaunch and keep this panel
                    </MiniButton>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {displayState ? (
          <>
            <div className="mt-4">
            {view === "home" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-home" aria-labelledby="pharos-mini-app-tab-home">
                <StatusPanel
                  state={displayState}
                  canMutate={canMutate}
                  isMutating={mutationControlsDisabled}
                  pendingOperation={pendingOperation}
                  onMutate={mutate}
                  homeHeadline={headline}
                  homeScreenStatus={homeScreenStatus}
                  onAddToHomeScreen={handleAddToHomeScreen}
                  onSendSample={handleSendSample}
                />
              </section>
            ) : null}
            {view === "watchlist" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-watchlist" aria-labelledby="pharos-mini-app-tab-watchlist">
                {coinInsightTarget ? (
                  <div className="mb-4">
                    <CoinInsightPanel
                      state={displayState}
                      target={coinInsightTarget}
                      webApp={webApp}
                      onClose={() => setCoinInsightTarget(null)}
                    />
                  </div>
                ) : null}
                <WatchlistPanel
                  state={displayState}
                  canMutate={canMutate}
                  isMutating={mutationControlsDisabled}
                  pendingOperation={pendingOperation}
                  onMutate={mutate}
                  onRemove={handleRemoveCoin}
                  onOpenInsight={setCoinInsightTarget}
                  pendingUndo={pendingUndo}
                  onUndo={handleUndoRemove}
                  webApp={webApp}
                  nowSec={nowSec}
                  highlightedCoinId={highlightedCoinId}
                  targetCoinId={visibleCoinTarget}
                  onNavigateToCoin={setCoinTarget}
                />
              </section>
            ) : null}
            {view === "presets" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-presets" aria-labelledby="pharos-mini-app-tab-presets">
                <PresetsPanel
                  state={displayState}
                  canMutate={canMutate}
                  isMutating={mutationControlsDisabled}
                  pendingOperation={pendingOperation}
                  onMutate={mutate}
                  onUnfollowPreset={handleUnfollowPreset}
                />
              </section>
            ) : null}
            {view === "settings" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-settings" aria-labelledby="pharos-mini-app-tab-settings">
                <SettingsPanel
                  state={displayState}
                  canMutate={canMutate}
                  isMutating={mutationControlsDisabled}
                  pendingOperation={pendingOperation}
                  onMutate={mutate}
                  globalAlerts={confirmedGlobals}
                  onUnsubscribeAll={handleUnsubscribeAll}
                  onForgetMe={handleForgetMe}
                  hasShowConfirm={Boolean(webApp?.showConfirm)}
                />
              </section>
            ) : null}
            </div>

            <p className="pharos-meta mt-6 text-center">
              Pharos stores your Telegram user ID and chat ID to deliver alerts.
              {" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" onClick={openPrivacy} className="underline">What we keep</a>
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
