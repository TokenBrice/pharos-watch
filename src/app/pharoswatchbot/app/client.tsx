"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, ExternalLink, Info, RefreshCw, SlidersHorizontal } from "lucide-react";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { formatCoveragePayload, formatWhyPayload, miniAppPayloadIntent, parseMiniAppPayload } from "@shared/lib/telegram-mini-app-payloads";
import type { TelegramWebAppSdk } from "./telegram-sdk";
import type { CatalogCoin, CoinInsightTarget, FollowedPreset, SubscribedCoin, TelegramAlertType, TelegramDepegStepBps, TelegramMiniAppOperation, TelegramMiniAppState } from "./types";
import { useTelegramMainButton } from "./use-telegram-main-button";
import { useTelegramBridge } from "./use-telegram-bridge";
import { useMiniAppMutations } from "./use-mini-app-mutations";
import { isMiniAppErrorCode, MiniAppRequestError, miniAppErrorMessage, type MiniAppErrorCode } from "./error-messages";
import { MiniButton } from "./components/MiniButton";
import { TogglePill } from "./components/TogglePill";
import { HomeSkeleton } from "./components/HomeSkeleton";
import { ForgottenView } from "./components/ForgottenView";
import { PreviewState } from "./components/PreviewState";
import { StatusPanel } from "./components/StatusPanel";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { ALERT_LABELS, DEPEG_STEP_OPTIONS, PHAROS_COIN_PAGE_PREFIX, RECOMMENDED_OPERATION } from "./constants";
import { formatHour } from "./format";

const SESSION_ENDPOINT = API_PATHS.telegramMiniAppSession();
const PRESET_ALERT_TYPES = ["dews", "depeg", "safety"] as const;
type PresetAlertType = (typeof PRESET_ALERT_TYPES)[number];
/** When the tab returns to visible after being hidden longer than this, refetch the session to avoid stale state. */
const VISIBILITY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;
const FALLBACK_TIMEZONES = ["UTC", "Europe/Paris", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"] as const;
const BOT_USERNAME = "PharosWatchBot";

type ViewKey = "home" | "watchlist" | "presets" | "settings";

const ORDERED_VIEWS: ViewKey[] = ["home", "watchlist", "presets", "settings"];

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

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let code: MiniAppErrorCode | null = null;
    try {
      const payload = await response.json() as { code?: unknown };
      if (isMiniAppErrorCode(payload?.code)) code = payload.code;
    } catch {
      // body wasn't JSON or was empty — leave code null
    }
    throw new MiniAppRequestError(response.status, code);
  }
  return await response.json() as T;
}

function availableTimezones(): readonly string[] {
  // `Intl.supportedValuesOf` is ES2022 and not yet in the lib.dom types we target, so probe via an unknown cast.
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf === "function") {
    try {
      const values = intl.supportedValuesOf("timeZone");
      if (Array.isArray(values) && values.length > 0) return values;
    } catch {
      // fall through to curated list
    }
  }
  return FALLBACK_TIMEZONES;
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

function TimezonePicker({ state, canMutate, isMutating, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const current = state.subscriber.quietHours.timezone ?? "UTC";
  const options = useMemo(() => availableTimezones(), []);

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Timezone</h2>
        <span className="shrink-0 rounded-md border border-border/60 bg-background/65 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
          {current}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Used to convert quiet hours to your local time.</p>
      <label className="sr-only" htmlFor="telegram-mini-app-timezone">Timezone</label>
      <select
        id="telegram-mini-app-timezone"
        className="pharos-focus-ring mt-3 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        value={current}
        disabled={!canMutate || isMutating}
        onChange={(event) => onMutate({ kind: "set-timezone", timezone: event.target.value })}
      >
        {options.map((zone) => (
          <option key={zone} value={zone}>{zone}</option>
        ))}
      </select>
      <div className="mt-3">
        <MiniButton
          variant="secondary"
          disabled={!canMutate || isMutating || current === "UTC"}
          onClick={() => onMutate({ kind: "set-timezone", timezone: null })}
        >
          Use UTC (clear)
        </MiniButton>
      </div>
    </section>
  );
}

function DangerZoneSection({ canMutate, isMutating, onUnsubscribeAll, onForgetMe, hasShowConfirm }: {
  canMutate: boolean;
  isMutating: boolean;
  onUnsubscribeAll: () => void;
  onForgetMe: () => void;
  hasShowConfirm: boolean;
}) {
  // When the bridge can drive two native confirmations, tap once and let the
  // bridge escalate. Otherwise fall back to an in-page two-tap armed state.
  const [forgetArmed, setForgetArmed] = useState(false);
  const requiresArming = !hasShowConfirm;

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <h2 className="text-sm font-semibold text-foreground">Danger zone</h2>
      <p className="mt-1 text-xs text-muted-foreground">These actions can&apos;t be undone.</p>
      <div className="mt-3 grid gap-2">
        <MiniButton variant="danger" disabled={!canMutate || isMutating} onClick={onUnsubscribeAll}>
          Unsubscribe from all
        </MiniButton>
        <button
          type="button"
          disabled={!canMutate || isMutating}
          aria-label="Delete all my data"
          onClick={() => {
            if (requiresArming && !forgetArmed) {
              setForgetArmed(true);
              return;
            }
            onForgetMe();
          }}
          onBlur={() => setForgetArmed(false)}
          className={cn(
            "pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            forgetArmed
              ? "border-red-600/80 bg-red-600 text-white hover:bg-red-700"
              : "border-red-500/35 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300",
          )}
        >
          {forgetArmed ? "Tap again to confirm forever" : "Delete all my data"}
        </button>
      </div>
    </section>
  );
}

function SettingsPanel({ state, canMutate, isMutating, onMutate, optimisticGlobalAlerts, onUnsubscribeAll, onForgetMe, hasShowConfirm }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  optimisticGlobalAlerts: Record<TelegramAlertType, boolean> & { depegStepBps: TelegramDepegStepBps | null };
  onUnsubscribeAll: () => void;
  onForgetMe: () => void;
  hasShowConfirm: boolean;
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
      <TimezonePicker state={state} canMutate={canMutate} isMutating={isMutating} onMutate={onMutate} />
      <DangerZoneSection
        canMutate={canMutate}
        isMutating={isMutating}
        onUnsubscribeAll={onUnsubscribeAll}
        onForgetMe={onForgetMe}
        hasShowConfirm={hasShowConfirm}
      />
    </div>
  );
}

function formatAlertList(alertTypes: Record<TelegramAlertType, boolean>): string {
  const enabled = (Object.keys(ALERT_LABELS) as TelegramAlertType[]).filter((type) => alertTypes[type]);
  if (enabled.length === 0) return "None";
  return enabled.map((type) => ALERT_LABELS[type]).join(", ");
}

function findCoinContext(state: TelegramMiniAppState, coinId: string): { subscription: SubscribedCoin | null; catalog: CatalogCoin | null } {
  return {
    subscription: state.subscriptions.find((coin) => coin.stablecoinId === coinId) ?? null,
    catalog: state.catalog.searchableCoins.find((coin) => coin.stablecoinId === coinId) ?? null,
  };
}

function CoinInsightPanel({ state, target, webApp, onClose }: {
  state: TelegramMiniAppState;
  target: CoinInsightTarget;
  webApp: TelegramWebAppSdk | null;
  onClose: () => void;
}) {
  const { subscription, catalog } = findCoinContext(state, target.coinId);
  const symbol = subscription?.symbol ?? catalog?.symbol ?? target.coinId;
  const name = subscription?.name ?? catalog?.name ?? "Unknown or no longer tracked coin";
  const botPayload = target.kind === "why" ? formatWhyPayload(target.coinId) : formatCoveragePayload(target.coinId);
  const botUrl = `https://t.me/${BOT_USERNAME}?start=${botPayload}`;
  const handleOpenTelegram = () => {
    if (webApp?.openTelegramLink) webApp.openTelegramLink(botUrl);
    else webApp?.openLink?.(botUrl);
  };
  const handleOpenPharos = () => {
    webApp?.openLink?.(`${PHAROS_COIN_PAGE_PREFIX}${target.coinId}`);
  };
  const title = target.kind === "why" ? `Why ${symbol}` : `Coverage ${symbol}`;
  const isKnown = subscription != null || catalog != null;
  const alertSummary = subscription ? formatAlertList(subscription.alertTypes) : "Not in your explicit watchlist";

  return (
    <section className="rounded-2xl border border-sky-500/25 bg-sky-500/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="pharos-kicker">In-app {target.kind}</p>
          <h2 className="mt-1 truncate text-base font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{name}</p>
        </div>
        <MiniButton ariaLabel={`Close ${title}`} variant="secondary" onClick={onClose}>
          Close
        </MiniButton>
      </div>

      {target.kind === "why" ? (
        <div className="mt-4 grid gap-2 text-sm">
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Watch context</p>
            <p className="mt-1 text-foreground">{alertSummary}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Safety explainer</p>
            <p className="mt-1 text-muted-foreground">Full Safety Score notes are still delivered by the bot reply.</p>
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Registry</p>
            <p className="mt-1 text-foreground">{isKnown ? "Tracked by Pharos" : "No current catalog match"}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Peg</p>
            <p className="mt-1 text-foreground">{catalog?.peg ?? "Not available in this launch"}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Status</p>
            <p className="mt-1 text-foreground">{catalog?.status ?? "Not available in this launch"}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Alert coverage</p>
            <p className="mt-1 text-foreground">{alertSummary}</p>
          </div>
        </div>
      )}

      {!isKnown ? (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
          This launch target is not in the current Mini App catalog. No settings were changed.
        </p>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <MiniButton variant="secondary" disabled={!webApp} onClick={handleOpenTelegram}>
          <Info className="h-4 w-4" aria-hidden="true" /> Open bot reply
        </MiniButton>
        <MiniButton variant="secondary" disabled={!webApp} onClick={handleOpenPharos}>
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> View on Pharos
        </MiniButton>
      </div>
    </section>
  );
}

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
    message,
    announcement,
    forgottenView,
    pendingUndo,
    homeScreenStatus,
    mutate,
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
      setState(await postJson<TelegramMiniAppState>(SESSION_ENDPOINT, { initData: nextInitData }));
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
      void loadSession(initData);
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [initData, loadSession]);

  const handleClose = useCallback(() => {
    webApp?.close?.();
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
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
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
  const { text: mainButtonText, handler: mainButtonHandler } = useMemo<{ text: string | null; handler: (() => void) | null }>(() => {
    if (view === "home") {
      if (state && !state.subscriber.exists) {
        return { text: "Use recommended setup", handler: () => mutate(RECOMMENDED_OPERATION) };
      }
      if (state?.subscriber.snoozeUntilTs != null) {
        return { text: "Clear snooze", handler: () => mutate({ kind: "clear-snooze" }) };
      }
    }
    return { text: null, handler: null };
  }, [mutate, state, view]);
  useTelegramMainButton({ webApp, text: mainButtonText, handler: mainButtonHandler });

  if (status === "preview") return <PreviewState previewName={previewName} />;
  if (forgottenView) return <ForgottenView onClose={handleClose} />;

  const heading = state?.viewer.username ? `@${state.viewer.username}` : state?.viewer.chatId ? `Chat ${state.viewer.chatId}` : "PharosWatchBot";
  const canMutate = Boolean(initData && state?.viewer.canMutate);
  const nowSec = Math.floor(Date.now() / 1000);

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
        {status === "error" ? <section role="alert" className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4"><p className="text-sm font-semibold text-red-700 dark:text-red-300">{message}</p><div className="mt-3"><MiniButton variant="secondary" onClick={() => void loadSession(initData)}>Retry</MiniButton></div></section> : null}
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
                    if (key !== "watchlist") setCoinInsightTarget(null);
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
                <StatusPanel
                  state={optimisticState}
                  canMutate={canMutate}
                  isMutating={isMutating}
                  onMutate={mutate}
                  optimisticHomeHeadline={headline}
                  homeScreenStatus={homeScreenStatus}
                  onAddToHomeScreen={handleAddToHomeScreen}
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
                  isMutating={isMutating}
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
                  isMutating={isMutating}
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
                  isMutating={isMutating}
                  onMutate={mutate}
                  optimisticGlobalAlerts={optimisticGlobals}
                  onUnsubscribeAll={handleUnsubscribeAll}
                  onForgetMe={handleForgetMe}
                  hasShowConfirm={Boolean(webApp?.showConfirm)}
                />
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
