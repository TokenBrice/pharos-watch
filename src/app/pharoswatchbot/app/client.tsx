"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bell, Bot, Check, Clock3, ExternalLink, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { applyTelegramTheme, bindTelegramViewportAndTheme, getTelegramLaunchContext, type TelegramWebAppSdk } from "./telegram-sdk";
import type { TelegramAlertType, TelegramDepegStepBps, TelegramMiniAppOperation, TelegramMiniAppState } from "./types";

const SESSION_ENDPOINT = API_PATHS.telegramMiniAppSession();
const MUTATE_ENDPOINT = API_PATHS.telegramMiniAppMutation();
const BOT_URL = "https://t.me/PharosWatchBot";
const ALERT_LABELS = { dews: "DEWS", depeg: "Depeg", safety: "Safety", launch: "Launch" } as const satisfies Record<TelegramAlertType, string>;
const DEPEG_STEP_OPTIONS = [
  { value: null, label: "Any depeg", caption: "No gate" },
  { value: 100, label: "+100 bps", caption: "Tighter" },
  { value: 250, label: "+250 bps", caption: "Balanced" },
  { value: 500, label: "+500 bps", caption: "Quieter" },
] as const satisfies readonly { value: TelegramDepegStepBps | null; label: string; caption: string }[];
const RECOMMENDED_OPERATION = { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] } as const satisfies TelegramMiniAppOperation;
const TELEGRAM_BROWSER_PREVIEW_ATTEMPTS = 10;
const TELEGRAM_LAUNCH_MAX_ATTEMPTS = 160;
const TELEGRAM_LAUNCH_RETRY_MS = 50;

type ViewKey = "home" | "watchlist" | "settings";

class MiniAppRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Request failed with ${status}`);
    this.name = "MiniAppRequestError";
    this.status = status;
  }
}

function initialViewFromStartParam(startParam: string | null): ViewKey {
  if (startParam === "settings") return "settings";
  if (startParam === "watchlist" || startParam?.startsWith("coin_")) return "watchlist";
  return "home";
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new MiniAppRequestError(response.status);
  return await response.json() as T;
}

function sessionErrorMessage(err: unknown): string {
  if (err instanceof MiniAppRequestError) {
    if (err.status === 401) return "Telegram launch authorization was rejected. Close and reopen from PharosWatchBot.";
    if (err.status === 429) return "Telegram is still opening your session. Wait a moment, then retry.";
    if (err.status === 503) return "Telegram Mini App auth is temporarily unavailable. Try again shortly.";
  }
  return "Could not load Mini App settings. Reopen from Telegram or try again.";
}

function formatTime(ts: number | null): string {
  if (ts == null) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ts * 1000));
}

function MiniButton({ ariaLabel, children, disabled, onClick, variant = "primary" }: {
  ariaLabel?: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pharos-focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" ? "bg-[var(--telegram-button,var(--brand-accent))] text-[var(--telegram-button-text,white)] hover:opacity-90" : "",
        variant === "secondary" ? "border border-border/65 bg-background/70 text-foreground hover:bg-muted/45" : "",
        variant === "danger" ? "border border-red-500/35 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300" : "",
      )}
    >
      {children}
    </button>
  );
}

function TogglePill({ label, enabled, disabled, onToggle }: { label: string; enabled: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "pharos-focus-ring inline-flex min-h-10 items-center justify-between gap-3 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        enabled ? "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/65 bg-background/60 text-muted-foreground hover:bg-muted/45",
      )}
    >
      <span>{label}</span>
      <span className={cn("h-2.5 w-2.5 rounded-full", enabled ? "bg-sky-500" : "bg-muted-foreground/35")} />
    </button>
  );
}

function PreviewState({ previewName }: { previewName: string | null }) {
  return (
    <section className="mx-auto flex min-h-[100svh] max-w-lg flex-col justify-center px-4 py-8">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300">
            <Bot className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">PharosWatchBot app preview</h1>
            <p className="text-xs text-muted-foreground">Read-only browser mode</p>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {previewName ? `${previewName}, open this page inside Telegram to manage alerts.` : "Open this page from the Telegram bot menu to load your alert settings."} Browser preview never shows Telegram launch data or saved chat settings.
        </p>
        <div className="mt-5 grid gap-2">
          <Button asChild className="gap-2">
            <a href={BOT_URL} target="_blank" rel="noopener noreferrer">Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
          </Button>
          <Button asChild variant="outline"><Link href="/pharoswatchbot/">View setup guide</Link></Button>
        </div>
      </section>
    </section>
  );
}

function StatusPanel({ state, canMutate, isMutating, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const activeGlobalCount = (Object.keys(ALERT_LABELS) as TelegramAlertType[]).filter((type) => state.subscriber.globalAlerts[type]).length;
  const readOnlyCopy = state.viewer.mutationBlockReason === "stale-auth"
    ? {
      title: "Reopen Telegram to edit settings",
      body: "This session is still readable, but edits require a fresh launch from Telegram.",
    }
    : {
      title: "Group settings are command-only for now",
      body: "Use /settings@PharosWatchBot in the group. Only group admins can change alert settings.",
    };

  return (
    <div className="space-y-4">
      {!state.viewer.canMutate ? (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">{readOnlyCopy.title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{readOnlyCopy.body}</p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <p className="pharos-kicker">Watcher state</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{state.subscriber.exists ? "Alerts are active" : "No active watcher yet"}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {state.subscriber.exists ? `${activeGlobalCount} global alert families, ${state.subscriptions.length} explicit coins, ${state.presets.length} presets.` : "Start with the recommended setup for DEWS and depeg alerts on the top USD stablecoins."}
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <MiniButton disabled={!canMutate || isMutating} onClick={() => onMutate(RECOMMENDED_OPERATION)}>
            <Check className="h-4 w-4" aria-hidden="true" /> Use recommended setup
          </MiniButton>
          <MiniButton variant="secondary" disabled={!canMutate || isMutating || state.subscriber.snoozeUntilTs == null} onClick={() => onMutate({ kind: "clear-snooze" })}>
            <Clock3 className="h-4 w-4" aria-hidden="true" /> Clear snooze
          </MiniButton>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
          <p className="pharos-kicker">Quiet hours</p>
          <p className="mt-2 text-lg font-semibold text-foreground">{state.subscriber.quietHours.enabled ? `${state.subscriber.quietHours.startHourUtc ?? "--"}-${state.subscriber.quietHours.endHourUtc ?? "--"} UTC` : "Off"}</p>
        </section>
        <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
          <p className="pharos-kicker">Delivery health</p>
          <p className="mt-2 text-lg font-semibold text-foreground">{formatTime(state.health.lastSuccessfulDeliveryAt)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{state.health.queuedAlerts} queued alerts</p>
        </section>
      </div>
    </div>
  );
}

function SettingsPanel({ state, canMutate, isMutating, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const currentDepegStep = state.subscriber.globalAlerts.depegStepBps;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Global alerts</h2>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {(Object.keys(ALERT_LABELS) as TelegramAlertType[]).map((type) => (
            <TogglePill key={type} label={ALERT_LABELS[type]} enabled={state.subscriber.globalAlerts[type]} disabled={!canMutate || isMutating} onToggle={() => onMutate({ kind: "set-global", alertType: type, enabled: !state.subscriber.globalAlerts[type] })} />
          ))}
        </div>
        <div className="mt-5 border-t border-border/60 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Depeg step</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Applies to all-stablecoin depeg alerts.</p>
            </div>
            <span className="shrink-0 rounded-md border border-border/60 bg-background/65 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
              {currentDepegStep == null ? "Any" : `${currentDepegStep} bps`}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DEPEG_STEP_OPTIONS.map((option) => {
              const selected = currentDepegStep === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-label={option.value == null ? "Set global depeg step to any depeg" : `Set global depeg step to ${option.value} bps`}
                  aria-pressed={selected}
                  disabled={!canMutate || isMutating}
                  onClick={() => onMutate({ kind: "set-global-depeg-step", depegStepBps: option.value })}
                  className={cn(
                    "pharos-focus-ring min-h-12 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    selected ? "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/65 bg-background/60 text-muted-foreground hover:bg-muted/45",
                  )}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="block text-[11px] leading-tight">{option.caption}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>
      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <h2 className="text-sm font-semibold text-foreground">Quiet hours</h2>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <MiniButton disabled={!canMutate || isMutating} onClick={() => onMutate({ kind: "set-quiet-hours", enabled: true, startHourUtc: 22, endHourUtc: 7 })}>Enable 22-07 UTC</MiniButton>
          <MiniButton variant="secondary" disabled={!canMutate || isMutating || !state.subscriber.quietHours.enabled} onClick={() => onMutate({ kind: "set-quiet-hours", enabled: false })}>Disable quiet hours</MiniButton>
        </div>
      </section>
    </div>
  );
}

function WatchlistPanel({ state, canMutate, isMutating, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const [query, setQuery] = useState("");
  const subscribed = useMemo(() => new Set(state.subscriptions.map((coin) => coin.stablecoinId)), [state.subscriptions]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return state.catalog.searchableCoins
      .filter((coin) => !subscribed.has(coin.stablecoinId) && (coin.symbol.toLowerCase().includes(q) || coin.name.toLowerCase().includes(q) || coin.stablecoinId.includes(q)))
      .slice(0, 8);
  }, [query, state.catalog.searchableCoins, subscribed]);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Add a coin</h2>
        </div>
        <label className="sr-only" htmlFor="telegram-mini-app-coin-search">Search stablecoins</label>
        <input id="telegram-mini-app-coin-search" className="pharos-focus-ring mt-3 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground placeholder:text-muted-foreground" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbol, name, or id" />
        {results.length > 0 ? (
          <div className="mt-3 grid gap-2">
            {results.map((coin) => (
              <div key={coin.stablecoinId} className="flex items-center justify-between gap-3 rounded-xl border border-border/65 bg-background/55 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{coin.symbol}</p>
                  <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
                </div>
                <MiniButton ariaLabel={`Add ${coin.symbol}`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { alertTypes: { dews: true, depeg: true } } })}>Add</MiniButton>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <div className="space-y-3">
        {state.subscriptions.length > 0 ? state.subscriptions.map((coin) => (
          <article key={coin.stablecoinId} className="rounded-2xl border border-border/70 bg-card/90 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-foreground">{coin.symbol}</h3>
                <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
              </div>
              <MiniButton ariaLabel={`Remove ${coin.symbol}`} variant="danger" disabled={!canMutate || isMutating} onClick={() => onMutate({ kind: "remove-coin", stablecoinId: coin.stablecoinId })}>
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
              </MiniButton>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(Object.keys(ALERT_LABELS) as TelegramAlertType[]).map((type) => (
                <span key={type} className={cn("rounded-md border px-2 py-1 text-[11px] font-semibold", coin.alertTypes[type] ? "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/55 bg-muted/25 text-muted-foreground")}>{ALERT_LABELS[type]}</span>
              ))}
            </div>
          </article>
        )) : (
          <section className="rounded-2xl border border-border/70 bg-card/90 p-4 text-sm text-muted-foreground">No explicit coin follows yet.</section>
        )}
      </div>
    </div>
  );
}

export function PharosWatchBotMiniAppClient() {
  const [webApp, setWebApp] = useState<TelegramWebAppSdk | null>(null);
  const [initData, setInitData] = useState("");
  const [startParam, setStartParam] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [state, setState] = useState<TelegramMiniAppState | null>(null);
  const [view, setView] = useState<ViewKey>("home");
  const [status, setStatus] = useState<"preview" | "loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  const loadSession = useCallback(async (nextInitData: string, nextStartParam: string | null) => {
    setStatus("loading");
    try {
      setState(await postJson<TelegramMiniAppState>(SESSION_ENDPOINT, { initData: nextInitData, startParam: nextStartParam }));
      setStatus("ready");
      setMessage(null);
    } catch (err) {
      setStatus("error");
      setMessage(sessionErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleanup = () => {};
    let attempts = 0;

    const initialize = () => {
      const launch = getTelegramLaunchContext();
      const shouldKeepWaiting = !launch.initData
        && attempts < TELEGRAM_LAUNCH_MAX_ATTEMPTS
        && (launch.hasTelegramLaunchHint || attempts < TELEGRAM_BROWSER_PREVIEW_ATTEMPTS);
      if (shouldKeepWaiting) {
        attempts += 1;
        timer = setTimeout(initialize, TELEGRAM_LAUNCH_RETRY_MS);
        return;
      }
      if (cancelled) return;
      setWebApp(launch.webApp);
      setInitData(launch.initData);
      setStartParam(launch.startParam);
      setView(initialViewFromStartParam(launch.startParam));
      setPreviewName(launch.previewName);
      applyTelegramTheme(launch.webApp);
      cleanup = bindTelegramViewportAndTheme(launch.webApp);
      launch.webApp?.ready?.();
      if (launch.initData) {
        void loadSession(launch.initData, launch.startParam);
      } else if (launch.hasTelegramLaunchHint) {
        setStatus("error");
        setMessage("Telegram launch data was not available. Close and reopen from PharosWatchBot.");
      } else {
        setStatus("preview");
      }
    };

    initialize();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      cleanup();
    };
  }, [loadSession]);

  const mutate = useCallback(async (operation: TelegramMiniAppOperation) => {
    if (!initData || state?.viewer.canMutate !== true) return;
    setIsMutating(true);
    webApp?.enableClosingConfirmation?.();
    try {
      setState(await postJson<TelegramMiniAppState>(MUTATE_ENDPOINT, { initData, operation }));
      setMessage(null);
      webApp?.HapticFeedback?.impactOccurred?.("light");
    } catch {
      setMessage("Change was not saved. Reopen from Telegram if authorization expired.");
    } finally {
      setIsMutating(false);
      webApp?.disableClosingConfirmation?.();
    }
  }, [initData, state?.viewer.canMutate, webApp]);

  if (status === "preview") return <PreviewState previewName={previewName} />;

  const heading = state?.viewer.username ? `@${state.viewer.username}` : state?.viewer.chatId ? `Chat ${state.viewer.chatId}` : "PharosWatchBot";
  const canMutate = Boolean(initData && state?.viewer.canMutate);

  return (
    <section className="min-h-[max(var(--telegram-viewport-height,100svh),100svh)] bg-[var(--telegram-bg,var(--background))] text-[var(--telegram-text,var(--foreground))]">
      <div className="mx-auto flex max-w-2xl flex-col px-3 py-4 pb-[calc(env(safe-area-inset-bottom)+var(--telegram-safe-area-bottom,0px)+1rem)] sm:px-4">
        <header className="rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="pharos-kicker">Telegram Mini App</p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-foreground">{heading}</h1>
              <p className="mt-1 text-sm text-muted-foreground">Manage stablecoin alerts without sending commands.</p>
            </div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300">
              <Bell className="h-5 w-5" aria-hidden="true" />
            </span>
          </div>
          {startParam ? <p className="mt-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2 text-xs text-muted-foreground">Launch intent: <span className="font-mono text-foreground">{startParam}</span></p> : null}
        </header>

        {status === "loading" ? <section aria-live="polite" className="mt-4 rounded-2xl border border-border/70 bg-card/90 p-5"><div className="flex items-center gap-3 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading Telegram settings...</div></section> : null}
        {status === "error" ? <section role="alert" className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4"><p className="text-sm font-semibold text-red-700 dark:text-red-300">{message}</p><div className="mt-3"><MiniButton variant="secondary" onClick={() => void loadSession(initData, startParam)}>Retry</MiniButton></div></section> : null}
        {message && status === "ready" ? <section role="status" className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">{message}</section> : null}

        {state ? (
          <>
            <nav className="my-4 grid grid-cols-3 gap-1 rounded-xl border border-border/65 bg-background/60 p-1" aria-label="Mini App sections">
              {(["home", "watchlist", "settings"] as ViewKey[]).map((key) => (
                <button key={key} type="button" onClick={() => setView(key)} className={cn("pharos-focus-ring min-h-10 rounded-lg px-2 text-sm font-semibold capitalize transition-colors", view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted/40")}>{key}</button>
              ))}
            </nav>
            {view === "home" ? <StatusPanel state={state} canMutate={canMutate} isMutating={isMutating} onMutate={mutate} /> : null}
            {view === "watchlist" ? <WatchlistPanel state={state} canMutate={canMutate} isMutating={isMutating} onMutate={mutate} /> : null}
            {view === "settings" ? <SettingsPanel state={state} canMutate={canMutate} isMutating={isMutating} onMutate={mutate} /> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
