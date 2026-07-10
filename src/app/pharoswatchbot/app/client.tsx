"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { miniAppPayloadIntent, parseMiniAppPayload } from "@shared/lib/telegram-mini-app-payloads";
import type { CoinInsightTarget, TelegramAlertType, TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
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
import { ALERT_LABELS, RECOMMENDED_OPERATION } from "./constants";
import { isPausedSentinel } from "./format";
import { postMiniAppJson, TelegramMiniAppStateSchema } from "./mini-app-api";

const SESSION_ENDPOINT = API_PATHS.telegramMiniAppSession();
const BOT_URL = "https://t.me/PharosWatchBot";
/** Bot DM deep link that triggers the synthetic `/sample` alert (the Mini App cannot call the Bot API). */
const BOT_DM_SAMPLE_LINK = "https://t.me/PharosWatchBot?start=sample";
/** When the tab returns to visible after being hidden longer than this, refetch the session to avoid stale state. */
const VISIBILITY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

type ViewKey = "home" | "watchlist" | "presets" | "settings";

const ORDERED_VIEWS: ViewKey[] = ["home", "watchlist", "presets", "settings"];

// Roving tabindex needs the arrow-key half of the ARIA tabs contract,
// otherwise inactive tabs are unreachable by keyboard.
function nextTabViewForKey(view: ViewKey, key: string): ViewKey | null {
  const currentIndex = ORDERED_VIEWS.indexOf(view);
  if (key === "ArrowRight") return ORDERED_VIEWS[(currentIndex + 1) % ORDERED_VIEWS.length];
  if (key === "ArrowLeft") return ORDERED_VIEWS[(currentIndex - 1 + ORDERED_VIEWS.length) % ORDERED_VIEWS.length];
  if (key === "Home") return ORDERED_VIEWS[0];
  if (key === "End") return ORDERED_VIEWS[ORDERED_VIEWS.length - 1];
  return null;
}

function initialViewFromStartParam(startParam: string | null): { view: ViewKey; coinId: string | null; insight: CoinInsightTarget | null } {
  const payload = parseMiniAppPayload(startParam);
  if (!payload) return { view: "home", coinId: null, insight: null };
  const intent = miniAppPayloadIntent(payload);
  if (intent === "settings" || intent === "presets") return { view: intent, coinId: null, insight: null };
  if (intent === "quiet-hours" || intent === "forget") return { view: "settings", coinId: null, insight: null };
  if (intent === "coin") return { view: "watchlist", coinId: payload.kind === "coin" ? payload.coinId : null, insight: null };
  if (intent === "why" || intent === "coverage") {
    return {
      view: "watchlist",
      coinId: payload.kind === "why" || payload.kind === "coverage" ? payload.coinId : null,
      insight: payload.kind === "why" || payload.kind === "coverage" ? { kind: payload.kind, coinId: payload.coinId } : null,
    };
  }
  if (intent === "watchlist") return { view: "watchlist", coinId: null, insight: null };
  return { view: "home", coinId: null, insight: null };
}

export function PharosWatchBotMiniAppClient() {
  const [state, setState] = useState<TelegramMiniAppState | null>(null);
  const [view, setView] = useState<ViewKey>("home");
  const [coinTarget, setCoinTarget] = useState<string | null>(null);
  const [visibleCoinTarget, setVisibleCoinTarget] = useState<string | null>(null);
  const [coinInsightTarget, setCoinInsightTarget] = useState<CoinInsightTarget | null>(null);
  const [highlightedCoinId, setHighlightedCoinId] = useState<string | null>(null);
  // Session network status. The bridge hook owns the Telegram probe lifecycle; this state only
  // tracks the session fetch + the "missing launch data" terminal error after the bridge resolves.
  const [status, setStatus] = useState<"preview" | "loading" | "ready" | "error">("loading");
  const lastHiddenAtRef = useRef<number | null>(null);
  const mainButtonInFlightRef = useRef(false);
  const hasInitialisedFromStartParamRef = useRef(false);
  // Forward-ref to `loadSession` so the mutations hook can call back for stale-auth recovery
  // even though `loadSession` is defined later (it depends on the hook's `setMessage`).
  const loadSessionRef = useRef<((nextInitData: string, options?: { clearMessage?: boolean }) => Promise<void>) | null>(null);

  // BackButton handler reacts to the current view/insight target.
  const handleTelegramBack = useCallback(() => {
    if (coinInsightTarget) {
      setCoinInsightTarget(null);
      return;
    }
    setView("home");
  }, [coinInsightTarget]);

  const handleTelegramSettings = useCallback(() => setView("settings"), []);

  const backButtonVisible = view !== "home" || coinInsightTarget != null;
  const { webApp, initData, startParam, previewName, status: bridgeStatus } = useTelegramBridge({
    onBack: handleTelegramBack,
    backButtonVisible,
    onSettings: handleTelegramSettings,
  });

  const reloadSession = useCallback(async (options?: { clearMessage?: boolean }) => {
    const fn = loadSessionRef.current;
    if (fn && initData) await fn(initData, options);
  }, [initData]);

  const mutations = useMiniAppMutations({
    initData,
    state,
    webApp,
    onStateReplaced: setState,
    reloadSession,
    messageAutoDismissActive: status === "ready",
  });
  const {
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
      setState(await postMiniAppJson(SESSION_ENDPOINT, { initData: nextInitData }, TelegramMiniAppStateSchema));
      setStatus("ready");
      if (options.clearMessage !== false) setMessage(null);
    } catch (err) {
      setStatus("error");
      setMessage(miniAppErrorMessage(err, "session"));
    }
  }, [setMessage]);
  useEffect(() => { loadSessionRef.current = loadSession; }, [loadSession]);

  const headline = useMemo(() => {
    if (!optimisticState) return "";
    const activeGlobalCount = (Object.keys(ALERT_LABELS) as TelegramAlertType[]).filter((type) => optimisticState.subscriber.globalAlerts[type]).length;
    const presetCount = optimisticState.presets.length;
    const presetClause = presetCount > 0 ? `, ${presetCount} presets` : "";
    return `${activeGlobalCount} global alert families, ${optimisticState.subscriptions.length} explicit coins${presetClause}.`;
  }, [optimisticState]);

  // Translate bridge resolution into our session-level status and kick off the initial fetch.
  // Runs once per bridge-status transition; downstream session reloads go through `loadSession`.
  useEffect(() => {
    if (bridgeStatus === "loading") return;
    if (!hasInitialisedFromStartParamRef.current) {
      hasInitialisedFromStartParamRef.current = true;
      const initial = initialViewFromStartParam(startParam);
      setView(initial.view);
      setCoinTarget(initial.coinId);
      setVisibleCoinTarget(initial.insight ? null : initial.coinId);
      setCoinInsightTarget(initial.insight);
    }
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
  }, [bridgeStatus, initData, loadSession, setMessage, startParam]);

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

  // Scroll-to-coin: when launched with `coin_<id>`, scroll the matching row
  // into view and apply a temporary highlight. Runs once per coin target.
  useEffect(() => {
    if (!coinTarget) return;
    if (view !== "watchlist") return;
    if (!state) return;
    const exists = state.subscriptions.some((coin) => coin.stablecoinId === coinTarget)
      || state.catalog.searchableCoins.some((coin) => coin.stablecoinId === coinTarget)
      || visibleCoinTarget === coinTarget;
    if (!exists) return;
    const targetId = coinTarget;
    // Consume the target so re-renders don't repeatedly scroll.
    setCoinTarget(null);
    setHighlightedCoinId(targetId);
    // Defer one tick so the highlighted-row re-render commits before scroll.
    const scrollTimer = setTimeout(() => {
      const node = typeof document === "undefined" ? null : document.getElementById(`coin-row-${targetId}`);
      const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      node?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    }, 0);
    const clearTimer = setTimeout(() => {
      setHighlightedCoinId((current) => (current === targetId ? null : current));
    }, 2_000);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [coinTarget, state, view, visibleCoinTarget]);

  // MainButton — derive `text` and `handler` from the current view/state and
  // delegate the Telegram lifecycle (attach/detach, setParams, show/hide) to
  // the shared hook. See `use-telegram-main-button.ts` for the cleanup contract.
  const canMutate = Boolean(initData && state?.viewer.canMutate);
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
      if (optimisticState && !optimisticState.subscriber.exists) {
        return { text: "Use recommended setup", handler: () => runMainButtonMutation(RECOMMENDED_OPERATION) };
      }
      if (optimisticState?.subscriber.snoozeUntilTs != null) {
        const label = isPausedSentinel(optimisticState.subscriber.snoozeUntilTs) ? "Resume alerts" : "Clear snooze";
        return { text: label, handler: () => runMainButtonMutation({ kind: "clear-snooze" }) };
      }
    }
    return { text: null, handler: null };
  }, [canMutate, mutationControlsDisabled, optimisticState, runMainButtonMutation, view]);
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
  const showStaleAuthBanner = optimisticState?.viewer.mutationBlockReason === "stale-auth";
  const nowSec = Math.floor(Date.now() / 1000);

  const openPrivacy = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (webApp?.openLink) {
      event.preventDefault();
      webApp.openLink(`${typeof window === "undefined" ? "" : window.location.origin}/privacy`);
    }
  };

  const activateView = (key: ViewKey) => {
    setView(key);
    if (key !== "watchlist") setCoinInsightTarget(null);
    webApp?.HapticFeedback?.selectionChanged?.();
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const nextKey = nextTabViewForKey(view, event.key);
    if (!nextKey) return;
    event.preventDefault();
    activateView(nextKey);
    document.getElementById(`pharos-mini-app-tab-${nextKey}`)?.focus();
  };

  return (
    <section className="pharos-mini-app min-h-[max(var(--telegram-viewport-height,100svh),100svh)] bg-[var(--telegram-bg,var(--background))] text-[var(--telegram-text,var(--foreground))]">
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
          {optimisticState ? (
            <nav className="grid grid-cols-4 gap-1 rounded-xl border border-border/65 bg-background/60 p-1" role="tablist" aria-label="Mini App sections">
              {ORDERED_VIEWS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`pharos-mini-app-tab-${key}`}
                  aria-controls={`pharos-mini-app-panel-${key}`}
                  aria-selected={view === key}
                  tabIndex={view === key ? 0 : -1}
                  onClick={() => activateView(key)}
                  onKeyDown={handleTabKeyDown}
                  className={cn(
                    "pharos-focus-ring min-h-11 whitespace-nowrap rounded-lg px-1 text-xs font-semibold capitalize transition-colors",
                    view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {key}
                </button>
              ))}
            </nav>
          ) : null}
        </div>
        <span className="sr-only" aria-live="polite">{announcement}</span>

        {status === "loading" && !optimisticState ? <HomeSkeleton /> : null}
        {status === "loading" && optimisticState ? <p className="sr-only" aria-live="polite">Refreshing settings</p> : null}
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
              </div>
            </div>
          </section>
        ) : null}

        {optimisticState ? (
          <>
            <div className="mt-4">
            {view === "home" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-home" aria-labelledby="pharos-mini-app-tab-home">
                <StatusPanel
                  state={optimisticState}
                  canMutate={canMutate}
                  isMutating={mutationControlsDisabled}
                  pendingOperation={pendingOperation}
                  onMutate={mutate}
                  optimisticHomeHeadline={headline}
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
                      state={optimisticState}
                      target={coinInsightTarget}
                      webApp={webApp}
                      onClose={() => setCoinInsightTarget(null)}
                    />
                  </div>
                ) : null}
                <WatchlistPanel
                  state={optimisticState}
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
                />
              </section>
            ) : null}
            {view === "presets" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-presets" aria-labelledby="pharos-mini-app-tab-presets">
                <PresetsPanel
                  state={optimisticState}
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
                  state={optimisticState}
                  canMutate={canMutate}
                  isMutating={mutationControlsDisabled}
                  pendingOperation={pendingOperation}
                  onMutate={mutate}
                  optimisticGlobalAlerts={optimisticGlobals}
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
