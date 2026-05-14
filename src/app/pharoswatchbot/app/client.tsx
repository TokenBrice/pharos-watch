"use client";

import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Bell, Bot, Check, Clock3, ExternalLink, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Trash2, Undo2 } from "lucide-react";
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
const PRESET_ALERT_TYPES = ["dews", "depeg", "safety"] as const;
type PresetAlertType = (typeof PRESET_ALERT_TYPES)[number];
const DEPEG_STEP_OPTIONS = [
  { value: null, label: "Any depeg", caption: "No gate" },
  { value: 100, label: "+100 bps", caption: "Tighter" },
  { value: 250, label: "+250 bps", caption: "Balanced" },
  { value: 500, label: "+500 bps", caption: "Quieter" },
] as const satisfies readonly { value: TelegramDepegStepBps | null; label: string; caption: string }[];
const SUGGESTED_SEARCH_IDS = ["usdt-tether", "usdc-circle", "dai-makerdao"] as const;
const RECOMMENDED_OPERATION = { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] } as const satisfies TelegramMiniAppOperation;
const TELEGRAM_BROWSER_PREVIEW_ATTEMPTS = 10;
const TELEGRAM_LAUNCH_MAX_ATTEMPTS = 160;
const TELEGRAM_LAUNCH_RETRY_MS = 50;
const UNDO_WINDOW_MS = 5_000;
const VISIBILITY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

type ViewKey = "home" | "watchlist" | "presets" | "settings";

const ORDERED_VIEWS: ViewKey[] = ["home", "watchlist", "presets", "settings"];

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
  if (startParam === "presets") return "presets";
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

function formatHour(hour: number | null | undefined): string {
  if (hour == null) return "--";
  return `${String(hour).padStart(2, "0")}:00`;
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
        "pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" ? "bg-[var(--telegram-button,var(--brand-accent))] text-[var(--telegram-button-text,white)] hover:opacity-90" : "",
        variant === "secondary" ? "border border-border/65 bg-background/70 text-foreground hover:bg-muted/45" : "",
        variant === "danger" ? "border border-red-500/35 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300" : "",
      )}
    >
      {children}
    </button>
  );
}

function TogglePill({ label, enabled, disabled, onToggle, ariaLabel }: { label: string; enabled: boolean; disabled?: boolean; onToggle: () => void; ariaLabel?: string }) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "pharos-focus-ring inline-flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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
          {previewName ? `${previewName}, open this page inside Telegram to manage alerts.` : "Open this page from the Telegram bot menu to load your alert settings."}
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

function HomeSkeleton() {
  return (
    <div className="mt-4 space-y-4" aria-busy="true" aria-live="polite" aria-label="Loading Telegram settings">
      <div className="h-32 animate-pulse rounded-2xl border border-border/70 bg-card/90" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-20 animate-pulse rounded-2xl border border-border/70 bg-card/90" />
        <div className="h-20 animate-pulse rounded-2xl border border-border/70 bg-card/90" />
      </div>
      <div className="h-12 animate-pulse rounded-xl border border-border/65 bg-background/60" />
    </div>
  );
}

function StatusPanel({ state, canMutate, isMutating, onMutate, optimisticHomeHeadline }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  optimisticHomeHeadline: string;
}) {
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
          {state.subscriber.exists ? optimisticHomeHeadline : "Start with the recommended setup for DEWS and depeg alerts on the top USD stablecoins."}
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
          <p className="mt-2 text-lg font-semibold text-foreground">
            {state.subscriber.quietHours.enabled
              ? `${formatHour(state.subscriber.quietHours.startHourUtc)}–${formatHour(state.subscriber.quietHours.endHourUtc)} UTC`
              : "Off"}
          </p>
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

function QuietHoursPicker({ state, canMutate, isMutating, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const enabled = state.subscriber.quietHours.enabled;
  const currentStart = state.subscriber.quietHours.startHourUtc;
  const currentEnd = state.subscriber.quietHours.endHourUtc;
  const [draftStartOverride, setDraftStart] = useState<number | null>(null);
  const [draftEndOverride, setDraftEnd] = useState<number | null>(null);
  const draftStart = draftStartOverride ?? currentStart ?? 22;
  const draftEnd = draftEndOverride ?? currentEnd ?? 7;

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const sameHours = draftStart === draftEnd;
  const summary = enabled && currentStart != null && currentEnd != null
    ? `Quiet hours: ${formatHour(currentStart)}–${formatHour(currentEnd)} UTC`
    : "Quiet hours off";

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <h2 className="text-sm font-semibold text-foreground">Quiet hours</h2>
      <p className="mt-1 text-xs text-muted-foreground">{summary}</p>
      <div className="mt-4 space-y-4">
        <fieldset>
          <legend className="pharos-kicker">Start (UTC)</legend>
          <div className="mt-2 grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Quiet hours start hour">
            {hours.map((hour) => {
              const selected = hour === draftStart;
              return (
                <button
                  key={`start-${hour}`}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`Start at ${formatHour(hour)} UTC`}
                  disabled={!canMutate || isMutating}
                  onClick={() => setDraftStart(hour)}
                  className={cn(
                    "pharos-focus-ring min-h-11 rounded-md border px-1 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    selected ? "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/55 bg-background/55 text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {formatHour(hour)}
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset>
          <legend className="pharos-kicker">End (UTC)</legend>
          <div className="mt-2 grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Quiet hours end hour">
            {hours.map((hour) => {
              const selected = hour === draftEnd;
              return (
                <button
                  key={`end-${hour}`}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`End at ${formatHour(hour)} UTC`}
                  disabled={!canMutate || isMutating}
                  onClick={() => setDraftEnd(hour)}
                  className={cn(
                    "pharos-focus-ring min-h-11 rounded-md border px-1 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    selected ? "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/55 bg-background/55 text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {formatHour(hour)}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <MiniButton
          disabled={!canMutate || isMutating || sameHours}
          onClick={() => onMutate({ kind: "set-quiet-hours", enabled: true, startHourUtc: draftStart, endHourUtc: draftEnd })}
        >
          {enabled ? "Save quiet hours" : "Enable quiet hours"}
        </MiniButton>
        <MiniButton variant="secondary" disabled={!canMutate || isMutating || !enabled} onClick={() => onMutate({ kind: "set-quiet-hours", enabled: false })}>
          Disable quiet hours
        </MiniButton>
      </div>
      {sameHours ? <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">Start and end must differ.</p> : null}
      <p className="pharos-meta mt-3">Times are UTC. Pharos doesn&apos;t track your timezone; convert from your local time.</p>
    </section>
  );
}

function SettingsPanel({ state, canMutate, isMutating, onMutate, optimisticGlobalAlerts }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  optimisticGlobalAlerts: Record<TelegramAlertType, boolean> & { depegStepBps: TelegramDepegStepBps | null };
}) {
  const currentDepegStep = optimisticGlobalAlerts.depegStepBps;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Global alerts</h2>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2" role="group" aria-label="Global alert types">
          {(Object.keys(ALERT_LABELS) as TelegramAlertType[]).map((type) => (
            <TogglePill
              key={type}
              label={ALERT_LABELS[type]}
              enabled={optimisticGlobalAlerts[type]}
              disabled={!canMutate || isMutating}
              onToggle={() => onMutate({ kind: "set-global", alertType: type, enabled: !optimisticGlobalAlerts[type] })}
            />
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
      <QuietHoursPicker state={state} canMutate={canMutate} isMutating={isMutating} onMutate={onMutate} />
    </div>
  );
}

function SegmentedControl<T>({ value, options, onChange, disabled, ariaLabel }: {
  value: T;
  options: readonly { value: T; label: string; caption?: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "pharos-focus-ring min-h-12 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              selected ? "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200" : "border-border/65 bg-background/60 text-muted-foreground hover:bg-muted/45",
            )}
          >
            <span className="block text-sm font-semibold">{option.label}</span>
            {option.caption ? <span className="block text-[11px] leading-tight">{option.caption}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

const DEWS_BAND_OPTIONS = [
  { value: "ALERT" as const, label: "ALERT", caption: "Light yellow" },
  { value: "WARNING" as const, label: "WARNING", caption: "Orange" },
  { value: "DANGER" as const, label: "DANGER", caption: "Red only" },
] as const;
const SAFETY_MODE_OPTIONS = [
  { value: "all" as const, label: "All changes" },
  { value: "downgrade-only" as const, label: "Downgrades" },
  { value: "upgrade-only" as const, label: "Upgrades" },
] as const;

type SubscribedCoin = TelegramMiniAppState["subscriptions"][number];

function CoinCard({ coin, canMutate, isMutating, onMutate, onRemove }: {
  coin: SubscribedCoin;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onRemove: (coin: SubscribedCoin) => void;
}) {
  const { dews: dewsEnabled, depeg: depegEnabled, safety: safetyEnabled } = coin.alertTypes;
  const showTune = dewsEnabled || depegEnabled || safetyEnabled;

  return (
    <article className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{coin.symbol}</h3>
          <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
        </div>
        <MiniButton ariaLabel={`Remove ${coin.symbol}`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => onRemove(coin)}>
          <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
        </MiniButton>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label={`${coin.symbol} alert types`}>
        {(Object.keys(ALERT_LABELS) as TelegramAlertType[]).map((type) => (
          <TogglePill
            key={type}
            label={ALERT_LABELS[type]}
            enabled={coin.alertTypes[type]}
            disabled={!canMutate || isMutating}
            ariaLabel={`${coin.symbol} ${ALERT_LABELS[type]}`}
            onToggle={() => onMutate({
              kind: "set-coin",
              stablecoinId: coin.stablecoinId,
              patch: { alertTypes: { [type]: !coin.alertTypes[type] } },
            })}
          />
        ))}
      </div>
      {showTune ? (
        <details className="mt-3 rounded-lg border border-border/55 bg-background/40 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-muted-foreground">
            Tune {coin.symbol}
          </summary>
          <div className="mt-3 space-y-4">
            {dewsEnabled ? (
              <div>
                <p className="pharos-kicker">DEWS minimum band</p>
                <div className="mt-2">
                  <SegmentedControl
                    ariaLabel={`${coin.symbol} DEWS minimum band`}
                    value={coin.dewsMinBand}
                    options={[{ value: null, label: "Default", caption: "Any band" }, ...DEWS_BAND_OPTIONS]}
                    disabled={!canMutate || isMutating}
                    onChange={(next) => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { dewsMinBand: next } })}
                  />
                </div>
              </div>
            ) : null}
            {depegEnabled ? (
              <div>
                <p className="pharos-kicker">Depeg step</p>
                <div className="mt-2">
                  <SegmentedControl
                    ariaLabel={`${coin.symbol} depeg step`}
                    value={coin.depegStepBps}
                    options={DEPEG_STEP_OPTIONS}
                    disabled={!canMutate || isMutating}
                    onChange={(next) => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { depegStepBps: next } })}
                  />
                </div>
              </div>
            ) : null}
            {safetyEnabled ? (
              <div>
                <p className="pharos-kicker">Safety changes</p>
                <div className="mt-2">
                  <SegmentedControl
                    ariaLabel={`${coin.symbol} safety mode`}
                    value={coin.safetyMode}
                    options={[{ value: null, label: "Default" }, ...SAFETY_MODE_OPTIONS]}
                    disabled={!canMutate || isMutating}
                    onChange={(next) => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { safetyMode: next } })}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function WatchlistPanel({ state, canMutate, isMutating, onMutate, onRemove, pendingUndo, onUndo }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onRemove: (coin: SubscribedCoin) => void;
  pendingUndo: SubscribedCoin | null;
  onUndo: () => void;
}) {
  const [query, setQuery] = useState("");
  const subscribed = useMemo(() => new Set(state.subscriptions.map((coin) => coin.stablecoinId)), [state.subscriptions]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return state.catalog.searchableCoins
      .filter((coin) => coin.symbol.toLowerCase().includes(q) || coin.name.toLowerCase().includes(q) || coin.stablecoinId.includes(q))
      .slice(0, 8);
  }, [query, state.catalog.searchableCoins]);
  const suggestions = useMemo(() => {
    const map = new Map(state.catalog.searchableCoins.map((coin) => [coin.stablecoinId, coin]));
    return SUGGESTED_SEARCH_IDS.map((id) => map.get(id)).filter((coin): coin is NonNullable<typeof coin> => Boolean(coin));
  }, [state.catalog.searchableCoins]);
  const queryLength = query.trim().length;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Add a coin</h2>
        </div>
        <label className="sr-only" htmlFor="telegram-mini-app-coin-search">Search stablecoins</label>
        <input
          id="telegram-mini-app-coin-search"
          className="pharos-focus-ring mt-3 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground placeholder:text-muted-foreground"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search symbol, name, or id"
        />
        {queryLength < 2 && suggestions.length > 0 ? (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {suggestions.map((coin) => (
              <button
                key={coin.stablecoinId}
                type="button"
                disabled={!canMutate || isMutating || subscribed.has(coin.stablecoinId)}
                onClick={() => setQuery(coin.symbol)}
                className={cn(
                  "pharos-focus-ring min-h-11 rounded-lg border px-2 py-2 text-center text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  "border-border/65 bg-background/55 text-foreground hover:bg-muted/40",
                )}
              >
                <span className="block">{coin.symbol}</span>
                <span className="block text-[10px] font-normal text-muted-foreground">{coin.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        {queryLength >= 2 && results.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">No matches. Try a symbol like USDT or a name like Frax.</p>
        ) : null}
        {results.length > 0 ? (
          <div className="mt-3 grid gap-2" aria-live="polite">
            {results.map((coin) => {
              const following = subscribed.has(coin.stablecoinId);
              return (
                <div key={coin.stablecoinId} className="flex items-center justify-between gap-3 rounded-xl border border-border/65 bg-background/55 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{coin.symbol}</p>
                    <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
                  </div>
                  {following ? (
                    <span className="shrink-0 rounded-md border border-border/55 bg-muted/30 px-2 py-1 text-[11px] font-semibold text-muted-foreground">Following</span>
                  ) : (
                    <MiniButton
                      ariaLabel={`Follow ${coin.symbol}`}
                      variant="secondary"
                      disabled={!canMutate || isMutating}
                      onClick={() => onMutate({ kind: "set-coin", stablecoinId: coin.stablecoinId, patch: { alertTypes: { dews: true, depeg: true } } })}
                    >
                      Follow
                    </MiniButton>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {pendingUndo ? (
        <section role="status" className="rounded-2xl border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-foreground">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate">{pendingUndo.symbol} removed from watchlist.</p>
            <MiniButton ariaLabel={`Undo remove ${pendingUndo.symbol}`} variant="secondary" disabled={!canMutate || isMutating} onClick={onUndo}>
              <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo
            </MiniButton>
          </div>
        </section>
      ) : null}

      <div className="space-y-3">
        {state.subscriptions.length > 0 ? state.subscriptions.map((coin) => (
          <CoinCard
            key={coin.stablecoinId}
            coin={coin}
            canMutate={canMutate}
            isMutating={isMutating}
            onMutate={onMutate}
            onRemove={onRemove}
          />
        )) : (
          <section className="rounded-2xl border border-border/70 bg-card/90 p-4 text-sm text-muted-foreground">No explicit coin follows yet.</section>
        )}
      </div>
    </div>
  );
}

type FollowedPreset = TelegramMiniAppState["presets"][number];
type RecommendedPreset = TelegramMiniAppState["catalog"]["recommendedPresets"][number];

function FollowedPresetCard({ preset, canMutate, isMutating, onMutate, onUnfollow }: {
  preset: FollowedPreset;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onUnfollow: (preset: FollowedPreset) => void;
}) {
  const updateAlertTypes = (nextAlertTypes: Partial<Record<PresetAlertType, boolean>>) => {
    onMutate({
      kind: "follow-preset",
      presetId: preset.id,
      alertTypes: nextAlertTypes,
      depegStepBps: preset.depegStepBps,
    });
  };

  return (
    <article className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{preset.label}</h3>
          {preset.description ? <p className="mt-1 text-xs text-muted-foreground">{preset.description}</p> : null}
        </div>
        <MiniButton ariaLabel={`Unfollow ${preset.label}`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => onUnfollow(preset)}>
          Unfollow
        </MiniButton>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label={`${preset.label} alert types`}>
        {PRESET_ALERT_TYPES.map((type) => (
          <TogglePill
            key={type}
            label={ALERT_LABELS[type]}
            enabled={Boolean(preset.alertTypes[type])}
            disabled={!canMutate || isMutating}
            ariaLabel={`${preset.label} ${ALERT_LABELS[type]}`}
            onToggle={() => {
              const next: Partial<Record<PresetAlertType, boolean>> = {};
              for (const t of PRESET_ALERT_TYPES) next[t] = Boolean(preset.alertTypes[t]);
              next[type] = !preset.alertTypes[type];
              updateAlertTypes(next);
            }}
          />
        ))}
      </div>
    </article>
  );
}

function AvailablePresetCard({ preset, canMutate, isMutating, onMutate }: {
  preset: RecommendedPreset;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<Partial<Record<PresetAlertType, boolean>>>({ dews: true, depeg: true, safety: false });
  const someSelected = PRESET_ALERT_TYPES.some((type) => pick[type]);

  return (
    <article className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{preset.label}</h3>
          {preset.description ? <p className="mt-1 text-xs text-muted-foreground">{preset.description}</p> : null}
        </div>
        {!picking ? (
          <MiniButton ariaLabel={`Follow ${preset.label}`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => setPicking(true)}>
            Follow
          </MiniButton>
        ) : null}
      </div>
      {picking ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">Choose alert families to follow.</p>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label={`${preset.label} alert types`}>
            {PRESET_ALERT_TYPES.map((type) => (
              <TogglePill
                key={type}
                label={ALERT_LABELS[type]}
                enabled={Boolean(pick[type])}
                disabled={!canMutate || isMutating}
                ariaLabel={`${preset.label} ${ALERT_LABELS[type]}`}
                onToggle={() => setPick((prev) => ({ ...prev, [type]: !prev[type] }))}
              />
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <MiniButton
              disabled={!canMutate || isMutating || !someSelected}
              onClick={() => {
                setPicking(false);
                onMutate({
                  kind: "follow-preset",
                  presetId: preset.id,
                  alertTypes: pick,
                });
              }}
            >
              Follow
            </MiniButton>
            <MiniButton variant="secondary" disabled={!canMutate || isMutating} onClick={() => setPicking(false)}>
              Cancel
            </MiniButton>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function PresetsPanel({ state, canMutate, isMutating, onMutate, onUnfollowPreset }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onUnfollowPreset: (preset: FollowedPreset) => void;
}) {
  const followedIds = useMemo(() => new Set(state.presets.map((preset) => preset.id)), [state.presets]);
  const available = useMemo(() => state.catalog.recommendedPresets.filter((preset) => !followedIds.has(preset.id)), [followedIds, state.catalog.recommendedPresets]);

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Followed presets</h2>
        {state.presets.length > 0 ? state.presets.map((preset) => (
          <FollowedPresetCard
            key={preset.id}
            preset={preset}
            canMutate={canMutate}
            isMutating={isMutating}
            onMutate={onMutate}
            onUnfollow={onUnfollowPreset}
          />
        )) : (
          <section className="rounded-2xl border border-border/70 bg-card/90 p-4 text-sm text-muted-foreground">No followed presets yet. Pick one below to track a bucket of coins at once.</section>
        )}
      </section>
      {available.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Available presets</h2>
          {available.map((preset) => (
            <AvailablePresetCard
              key={preset.id}
              preset={preset}
              canMutate={canMutate}
              isMutating={isMutating}
              onMutate={onMutate}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

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
  const [announcement, setAnnouncement] = useState("");
  const [pendingUndo, setPendingUndo] = useState<SubscribedCoin | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHiddenAtRef = useRef<number | null>(null);
  const [, startTransition] = useTransition();

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

  // Optimistic state derivations
  const [optimisticOperation, applyOptimisticOperation] = useOptimistic<
    TelegramMiniAppOperation | null,
    TelegramMiniAppOperation | null
  >(null, (_prev, next) => next);

  const optimisticGlobals = useMemo(() => {
    if (state && optimisticOperation) return optimisticGlobalAlerts(state, optimisticOperation);
    return state?.subscriber.globalAlerts ?? { dews: false, depeg: false, safety: false, launch: false, depegStepBps: null } as Record<TelegramAlertType, boolean> & { depegStepBps: TelegramDepegStepBps | null };
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
      return {
        ...coin,
        alertTypes: nextAlertTypes,
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

  const headline = useMemo(() => {
    if (!optimisticState) return "";
    const activeGlobalCount = (Object.keys(ALERT_LABELS) as TelegramAlertType[]).filter((type) => optimisticState.subscriber.globalAlerts[type]).length;
    const presetCount = optimisticState.presets.length;
    const presetClause = presetCount > 0 ? `, ${presetCount} presets` : "";
    return `${activeGlobalCount} global alert families, ${optimisticState.subscriptions.length} explicit coins${presetClause}.`;
  }, [optimisticState]);

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
      launch.webApp?.expand?.();
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

  // Eruda debug toggle (?debug=eruda)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV === "production") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") !== "eruda") return;
    let cancelled = false;
    (async () => {
      try {
        const erudaModule = await import(/* @vite-ignore */ /* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/eruda" as string);
        if (cancelled) return;
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
    void loadSession(initData, startParam);
  }, [initData, isMutating, loadSession, startParam, status]);

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
      void loadSession(initData, startParam);
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [initData, loadSession, startParam]);

  const performMutation = useCallback(async (operation: TelegramMiniAppOperation): Promise<TelegramMiniAppState | null> => {
    if (!initData || state?.viewer.canMutate !== true) return null;
    setIsMutating(true);
    webApp?.enableClosingConfirmation?.();
    try {
      const next = await postJson<TelegramMiniAppState>(MUTATE_ENDPOINT, { initData, operation });
      setState(next);
      setMessage(null);
      setAnnouncement(mutationSuccessAnnouncement(operation, next));
      const haptics = webApp?.HapticFeedback;
      if (operation.kind === "recommended-setup" || operation.kind === "set-coin" || operation.kind === "remove-coin") {
        haptics?.notificationOccurred?.("success");
      } else {
        haptics?.impactOccurred?.("light");
      }
      return next;
    } catch {
      setMessage("Change was not saved. Reopen from Telegram if authorization expired.");
      webApp?.HapticFeedback?.notificationOccurred?.("error");
      return null;
    } finally {
      setIsMutating(false);
      webApp?.disableClosingConfirmation?.();
    }
  }, [initData, state?.viewer.canMutate, webApp]);

  const mutate = useCallback((operation: TelegramMiniAppOperation) => {
    startTransition(() => {
      applyOptimisticOperation(operation);
    });
    void performMutation(operation);
  }, [applyOptimisticOperation, performMutation]);

  const clearPendingUndo = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setPendingUndo(null);
  }, []);

  const handleRemoveCoin = useCallback((coin: SubscribedCoin) => {
    const captured: SubscribedCoin = coin;
    void (async () => {
      const next = await performMutation({ kind: "remove-coin", stablecoinId: coin.stablecoinId });
      if (!next) return;
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setPendingUndo(captured);
      undoTimerRef.current = setTimeout(() => {
        setPendingUndo(null);
        undoTimerRef.current = null;
      }, UNDO_WINDOW_MS);
    })();
  }, [performMutation]);

  const handleUndoRemove = useCallback(() => {
    const captured = pendingUndo;
    if (!captured) return;
    clearPendingUndo();
    const patch: { alertTypes: Partial<Record<TelegramAlertType, boolean>>; dewsMinBand?: typeof captured.dewsMinBand; depegStepBps?: typeof captured.depegStepBps; safetyMode?: typeof captured.safetyMode; launch?: boolean } = {
      alertTypes: { ...captured.alertTypes },
    };
    if (captured.dewsMinBand !== null) patch.dewsMinBand = captured.dewsMinBand;
    if (captured.depegStepBps !== null) patch.depegStepBps = captured.depegStepBps;
    if (captured.safetyMode !== null) patch.safetyMode = captured.safetyMode;
    if (captured.alertTypes.launch) patch.launch = true;
    void performMutation({ kind: "set-coin", stablecoinId: captured.stablecoinId, patch });
  }, [clearPendingUndo, pendingUndo, performMutation]);

  const handleUnfollowPreset = useCallback((preset: FollowedPreset) => {
    // Presets aren't joined to subscribed coins in the current state payload, so we
    // always show the confirm sheet when the Telegram bridge exposes one (T-48).
    const confirmFn = webApp?.showConfirm;
    if (confirmFn) {
      confirmFn(`Unfollow ${preset.label}?`, (ok) => {
        if (ok) void performMutation({ kind: "unfollow-preset", presetId: preset.id });
      });
      return;
    }
    void performMutation({ kind: "unfollow-preset", presetId: preset.id });
  }, [performMutation, webApp?.showConfirm]);

  // BackButton
  useEffect(() => {
    const bb = webApp?.BackButton;
    if (!bb) return;
    if (view === "home") {
      bb.hide?.();
      return;
    }
    const handler = () => setView("home");
    bb.show?.();
    bb.onClick?.(handler);
    return () => {
      bb.offClick?.(handler);
      bb.hide?.();
    };
  }, [view, webApp]);

  // SettingsButton
  useEffect(() => {
    const sb = webApp?.SettingsButton;
    if (!sb) return;
    const handler = () => setView("settings");
    sb.onClick?.(handler);
    sb.show?.();
    return () => {
      sb.offClick?.(handler);
      sb.hide?.();
    };
  }, [webApp]);

  // MainButton
  useEffect(() => {
    const mb = webApp?.MainButton;
    if (!mb) return;
    const haptic = () => webApp?.HapticFeedback?.notificationOccurred?.("success");

    let handler: (() => void) | null = null;
    let text: string | null = null;
    if (view === "home") {
      if (state && !state.subscriber.exists) {
        text = "Use recommended setup";
        handler = () => { mutate(RECOMMENDED_OPERATION); haptic(); };
      } else if (state?.subscriber.snoozeUntilTs != null) {
        text = "Clear snooze";
        handler = () => mutate({ kind: "clear-snooze" });
      }
    }
    if (handler && text) {
      const buttonColor = webApp?.themeParams?.button_color;
      mb.setParams?.({ text, is_visible: true, is_active: true, ...(buttonColor ? { color: buttonColor } : {}) });
      mb.onClick?.(handler);
      mb.show?.();
      const localHandler = handler;
      return () => {
        mb.offClick?.(localHandler);
        mb.hide?.();
      };
    }
    mb.hide?.();
    return undefined;
  }, [mutate, state, view, webApp]);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  if (status === "preview") return <PreviewState previewName={previewName} />;

  const heading = state?.viewer.username ? `@${state.viewer.username}` : state?.viewer.chatId ? `Chat ${state.viewer.chatId}` : "PharosWatchBot";
  const canMutate = Boolean(initData && state?.viewer.canMutate);

  const openPrivacy = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (webApp?.openLink) {
      event.preventDefault();
      webApp.openLink(`${typeof window === "undefined" ? "" : window.location.origin}/privacy`);
    }
  };

  return (
    <section className="min-h-[max(var(--telegram-viewport-height,100svh),100svh)] bg-[var(--telegram-bg,var(--background))] text-[var(--telegram-text,var(--foreground))]">
      <div className="mx-auto flex max-w-2xl flex-col px-3 pt-[calc(env(safe-area-inset-top)+var(--telegram-safe-area-top,0px)+1rem)] pb-[calc(env(safe-area-inset-bottom)+var(--telegram-safe-area-bottom,0px)+1rem)] sm:px-4">
        <header className="rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="pharos-kicker">Telegram Mini App</p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-foreground">{heading}</h1>
              <p className="mt-1 text-sm text-muted-foreground">Manage stablecoin alerts without sending commands.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                aria-label="Refresh session"
                disabled={!initData || status === "loading" || isMutating}
                onClick={triggerRefresh}
                className="pharos-focus-ring inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/65 bg-background/60 text-foreground transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={cn("h-4 w-4", status === "loading" && "animate-spin")} aria-hidden="true" />
              </button>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                <Bell className="h-5 w-5" aria-hidden="true" />
              </span>
            </div>
          </div>
          {startParam ? <p className="mt-3 rounded-lg border border-border/60 bg-background/55 px-3 py-2 text-xs text-muted-foreground">Launch intent: <span className="font-mono text-foreground">{startParam}</span></p> : null}
        </header>

        <span className="sr-only" aria-live="polite">{announcement}</span>

        {status === "loading" && !optimisticState ? <HomeSkeleton /> : null}
        {status === "loading" && optimisticState ? <p className="sr-only" aria-live="polite">Refreshing settings</p> : null}
        {status === "error" ? <section role="alert" className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4"><p className="text-sm font-semibold text-red-700 dark:text-red-300">{message}</p><div className="mt-3"><MiniButton variant="secondary" onClick={() => void loadSession(initData, startParam)}>Retry</MiniButton></div></section> : null}
        {message && status === "ready" ? <section role="status" className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">{message}</section> : null}

        {optimisticState ? (
          <>
            <nav className="my-4 grid grid-cols-4 gap-1 rounded-xl border border-border/65 bg-background/60 p-1" role="tablist" aria-label="Mini App sections">
              {ORDERED_VIEWS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`pharos-mini-app-tab-${key}`}
                  aria-controls={`pharos-mini-app-panel-${key}`}
                  aria-selected={view === key}
                  tabIndex={view === key ? 0 : -1}
                  onClick={() => {
                    setView(key);
                    webApp?.HapticFeedback?.selectionChanged?.();
                  }}
                  className={cn(
                    "pharos-focus-ring min-h-11 rounded-lg px-2 text-sm font-semibold capitalize transition-colors",
                    view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {key}
                </button>
              ))}
            </nav>
            {view === "home" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-home" aria-labelledby="pharos-mini-app-tab-home">
                <StatusPanel state={optimisticState} canMutate={canMutate} isMutating={isMutating} onMutate={mutate} optimisticHomeHeadline={headline} />
              </section>
            ) : null}
            {view === "watchlist" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-watchlist" aria-labelledby="pharos-mini-app-tab-watchlist">
                <WatchlistPanel
                  state={optimisticState}
                  canMutate={canMutate}
                  isMutating={isMutating}
                  onMutate={mutate}
                  onRemove={handleRemoveCoin}
                  pendingUndo={pendingUndo}
                  onUndo={handleUndoRemove}
                />
              </section>
            ) : null}
            {view === "presets" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-presets" aria-labelledby="pharos-mini-app-tab-presets">
                <PresetsPanel
                  state={optimisticState}
                  canMutate={canMutate}
                  isMutating={isMutating}
                  onMutate={mutate}
                  onUnfollowPreset={handleUnfollowPreset}
                />
              </section>
            ) : null}
            {view === "settings" ? (
              <section role="tabpanel" id="pharos-mini-app-panel-settings" aria-labelledby="pharos-mini-app-tab-settings">
                <SettingsPanel state={optimisticState} canMutate={canMutate} isMutating={isMutating} onMutate={mutate} optimisticGlobalAlerts={optimisticGlobals} />
              </section>
            ) : null}

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
