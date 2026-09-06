"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { pluralizeCount } from "@shared/lib/telegram-metrics";
import type { TelegramAlertType, TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
import { useTelegramMainButton } from "./use-telegram-main-button";
import { useTelegramBridge } from "./use-telegram-bridge";
import { useMiniAppMutations } from "./use-mini-app-mutations";
import { miniAppErrorMessage } from "./error-messages";
import { ForgottenView } from "./components/ForgottenView";
import { PreviewState } from "./components/PreviewState";
import { MiniAppTabs } from "./components/MiniAppTabs";
import { MiniAppPanelRouter } from "./components/MiniAppPanelRouter";
import { MiniAppSessionStatus, type MiniAppSessionStatus as MiniAppSessionStatusValue } from "./components/MiniAppSessionStatus";
import { ALERT_LABELS, RECOMMENDED_OPERATION } from "./constants";
import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
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
  const [status, setStatus] = useState<MiniAppSessionStatusValue>("loading");
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
    portabilityReadsAllowed: status === "ready",
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
    performPortability,
    performBulkWatchlistPreview,
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
    const presetClause = presetCount > 0 ? `, ${presetCount} ${pluralizeCount(presetCount, "preset")}` : "";
    const coinCount = displayState.subscriptions.length;
    return `${activeGlobalCount} ${pluralizeCount(activeGlobalCount, "global alert family", "global alert families")}, ${coinCount} explicit ${pluralizeCount(coinCount, "coin")}${presetClause}.`;
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
  const canReadPortability = Boolean(initData && status === "ready" && state?.viewer.chatId != null);
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

        <MiniAppSessionStatus
          status={status}
          hasDisplayState={Boolean(displayState)}
          confirmedMeta={confirmedMeta}
          message={message}
          mutationRetryAfterSec={mutationRetryAfterSec}
          initData={initData}
          canClose={Boolean(webApp?.close)}
          showStaleAuthBanner={showStaleAuthBanner}
          onRefresh={triggerRefresh}
          onClose={handleClose}
          onStaleAuthRelaunch={handleStaleAuthRelaunch}
        />

        {displayState ? (
          <>
            <div className="mt-4">
              <MiniAppPanelRouter
                view={view}
                home={{
                  state: displayState,
                  canMutate,
                  isMutating: mutationControlsDisabled,
                  pendingOperation,
                  onMutate: mutate,
                  homeHeadline: headline,
                  homeScreenStatus,
                  onAddToHomeScreen: handleAddToHomeScreen,
                  onSendSample: handleSendSample,
                }}
                watchlist={{
                  state: displayState,
                  canMutate,
                  canReadBulk: canReadPortability,
                  isMutating: mutationControlsDisabled,
                  isRequestBusy: isMutating,
                  pendingOperation,
                  onMutate: mutate,
                  onPreviewBulk: performBulkWatchlistPreview,
                  onConfirmBulk: performMutation,
                  onUndoBulk: performMutation,
                  onRemove: handleRemoveCoin,
                  onOpenInsight: setCoinInsightTarget,
                  pendingUndo,
                  onUndo: handleUndoRemove,
                  webApp,
                  nowSec,
                  highlightedCoinId,
                  targetCoinId: visibleCoinTarget,
                  onNavigateToCoin: setCoinTarget,
                }}
                presets={{
                  state: displayState,
                  canMutate,
                  isMutating: mutationControlsDisabled,
                  pendingOperation,
                  onMutate: mutate,
                  onUnfollowPreset: handleUnfollowPreset,
                }}
                settings={{
                  state: displayState,
                  canMutate,
                  canReadPortability,
                  isMutating: mutationControlsDisabled,
                  isPortabilityRequestBusy: isMutating,
                  pendingOperation,
                  onMutate: mutate,
                  globalAlerts: confirmedGlobals,
                  onUnsubscribeAll: handleUnsubscribeAll,
                  onForgetMe: handleForgetMe,
                  hasShowConfirm: Boolean(webApp?.showConfirm),
                  onExportWatchlist: () => performPortability({ kind: "export-watchlist" }),
                  onPreviewWatchlistImport: (token) => performPortability({ kind: "preview-watchlist-import", token }),
                  onConfirmWatchlistImport: (operation) => performMutation(operation),
                }}
                coinInsight={coinInsightTarget ? {
                  state: displayState,
                  target: coinInsightTarget,
                  webApp,
                  onClose: () => setCoinInsightTarget(null),
                } : null}
              />
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
