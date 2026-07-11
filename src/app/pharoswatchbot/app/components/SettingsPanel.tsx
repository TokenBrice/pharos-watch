"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, SlidersHorizontal } from "lucide-react";
import { ALERT_LABELS, DEPEG_STEP_OPTIONS } from "../constants";
import { formatHour, formatQuietHoursRange, formatQuietHoursTimezone } from "../format";
import type {
  TelegramAlertType,
  TelegramDepegStepBps,
  TelegramMiniAppOperation,
  TelegramMiniAppPortabilityResponse,
  TelegramMiniAppState,
} from "../types";
import { MiniButton } from "./MiniButton";
import { SegmentedControl } from "./SegmentedControl";
import { TogglePill } from "./TogglePill";
import { WatchlistPortabilityPanel } from "./WatchlistPortabilityPanel";

const FALLBACK_TIMEZONES = ["UTC", "Europe/Paris", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"] as const;
const COMMON_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Belgrade",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;
const QUIET_HOUR_FIELDS = [
  { kind: "start", id: "mini-quiet-start", label: "Start" },
  { kind: "end", id: "mini-quiet-end", label: "End" },
] as const;

function availableTimezones(): readonly string[] {
  // `Intl.supportedValuesOf` is ES2022 and not yet in the lib.dom types we target, so probe via an unknown cast.
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf === "function") {
    try {
      const values = intl.supportedValuesOf("timeZone");
      if (Array.isArray(values) && values.length > 0) {
        return values.includes("UTC") ? values : ["UTC", ...values];
      }
    } catch {
      // fall through to curated list
    }
  }
  return FALLBACK_TIMEZONES;
}

function QuietHourSelect({ id, label, value, disabled, onChange, optionKeyPrefix, hours, timezoneLabel }: {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  optionKeyPrefix: string;
  hours: readonly number[];
  timezoneLabel: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="pharos-kicker">{label}</label>
      <select
        id={id}
        className="pharos-focus-ring pharos-numeric mt-2 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {hours.map((hour) => (
          <option key={`${optionKeyPrefix}-${hour}`} value={hour}>{formatHour(hour)} {timezoneLabel}</option>
        ))}
      </select>
    </div>
  );
}

function QuietHoursPicker({ state, canMutate, isMutating, pendingOperation, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const enabled = state.subscriber.quietHours.enabled;
  const currentStart = state.subscriber.quietHours.startHourUtc;
  const currentEnd = state.subscriber.quietHours.endHourUtc;
  const [draftStartOverride, setDraftStart] = useState<number | null>(null);
  const [draftEndOverride, setDraftEnd] = useState<number | null>(null);
  const draftStart = draftStartOverride ?? currentStart ?? 22;
  const draftEnd = draftEndOverride ?? currentEnd ?? 7;
  const timezoneLabel = formatQuietHoursTimezone(state.subscriber.quietHours.timezone);

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const selectDisabled = !canMutate || isMutating;
  const sameHours = draftStart === draftEnd;
  const summary = enabled && currentStart != null && currentEnd != null
    ? `Quiet hours: ${formatQuietHoursRange(currentStart, currentEnd, state.subscriber.quietHours.timezone)}`
    : "Quiet hours off";

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <h2 className="text-sm font-semibold text-foreground">Quiet hours</h2>
      <p className="mt-1 text-xs text-muted-foreground">{summary}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {QUIET_HOUR_FIELDS.map((field) => (
          <QuietHourSelect
            key={field.kind}
            id={field.id}
            label={field.label}
            value={field.kind === "start" ? draftStart : draftEnd}
            disabled={selectDisabled}
            onChange={field.kind === "start" ? setDraftStart : setDraftEnd}
            optionKeyPrefix={field.kind}
            hours={hours}
            timezoneLabel={timezoneLabel}
          />
        ))}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <MiniButton
          disabled={!canMutate || isMutating || sameHours}
          loading={pendingOperation?.kind === "set-quiet-hours" && pendingOperation.enabled === true}
          onClick={() => onMutate({ kind: "set-quiet-hours", enabled: true, startHourUtc: draftStart, endHourUtc: draftEnd })}
        >
          {enabled ? "Save quiet hours" : "Enable quiet hours"}
        </MiniButton>
        <MiniButton
          variant="secondary"
          disabled={!canMutate || isMutating || !enabled}
          loading={pendingOperation?.kind === "set-quiet-hours" && pendingOperation.enabled === false}
          onClick={() => onMutate({ kind: "set-quiet-hours", enabled: false })}
        >
          Disable quiet hours
        </MiniButton>
      </div>
      {sameHours ? (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
          Start and end must differ. For all-day silence, turn alert toggles off or unsubscribe instead.
        </p>
      ) : null}
      <p className="pharos-meta mt-3">Times use {timezoneLabel}. Change timezone below.</p>
    </section>
  );
}

const RECAP_OUTCOME_LABELS: Record<string, string> = {
  sent: "Sent",
  queued: "Queued",
  planned: "Planned",
  skipped_no_changes: "No material changes",
  skipped_paused: "Skipped while paused",
  skipped_stale: "Waiting for fresh data",
  cancelled: "Cancelled",
  expired: "Expired",
  execution_unknown: "Delivery unconfirmed",
  failed_permanent: "Delivery failed",
};

function formatRecapSchedule(ts: number | null, timezone: string | null): string {
  if (ts == null || timezone == null) return "Not scheduled";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(new Date(ts * 1000));
  } catch {
    return "Not scheduled";
  }
}

function DailyRecapSection({ state, canMutate, isMutating, pendingOperation, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const recap = state.subscriber.recap;
  const timezone = state.subscriber.quietHours.timezone;
  const controlsDisabled = !canMutate || isMutating;
  const enableDisabled = controlsDisabled || (!recap.enabled && !recap.timezoneConfirmed);
  const outcome = recap.lastOutcome == null
    ? "No recap history"
    : (RECAP_OUTCOME_LABELS[recap.lastOutcome] ?? "Recorded");

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4" aria-labelledby="daily-recap-heading">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-[color:var(--mini-accent)]" aria-hidden="true" />
            <h2 id="daily-recap-heading" className="text-sm font-semibold text-foreground">Daily recap</h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Sent only when watched assets materially changed.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={recap.enabled}
          aria-label="Daily recap"
          aria-busy={pendingOperation?.kind === "set-recap" && pendingOperation.enabled !== recap.enabled || undefined}
          disabled={enableDisabled}
          onClick={() => onMutate({
            kind: "set-recap",
            enabled: !recap.enabled,
            deliveryHourLocal: recap.deliveryHourLocal,
          })}
          className={recap.enabled
            ? "pharos-focus-ring relative inline-flex h-11 w-14 shrink-0 items-center rounded-full border border-[color:var(--mini-accent)] bg-[color:var(--mini-accent)] p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            : "pharos-focus-ring relative inline-flex h-11 w-14 shrink-0 items-center rounded-full border border-border/70 bg-background/70 p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50"}
        >
          <span className={recap.enabled
            ? "h-5 w-5 translate-x-5 rounded-full bg-white shadow-sm transition-transform"
            : "h-5 w-5 rounded-full bg-white shadow-sm transition-transform"} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div>
          <label htmlFor="mini-recap-hour" className="pharos-kicker">Delivery hour</label>
          <select
            id="mini-recap-hour"
            className="pharos-focus-ring pharos-numeric mt-2 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            value={recap.deliveryHourLocal}
            disabled={controlsDisabled}
            onChange={(event) => onMutate({
              kind: "set-recap",
              enabled: recap.enabled,
              deliveryHourLocal: Number(event.target.value),
            })}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={`recap-${hour}`} value={hour}>
                {formatHour(hour)} {timezone ?? "local"}
              </option>
            ))}
          </select>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-background/45 p-3 text-xs">
          <div className="min-w-0">
            <dt className="text-muted-foreground">Next</dt>
            <dd className="mt-1 font-medium text-foreground">{formatRecapSchedule(recap.nextDueAt, timezone)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Last result</dt>
            <dd className="mt-1 font-medium text-foreground">{outcome}</dd>
          </div>
        </dl>
      </div>

      {!recap.timezoneConfirmed ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300" role="status">
          Confirm a timezone below before enabling your recap.
        </p>
      ) : (
        <p className="pharos-meta mt-3">Scheduled in {timezone}. <a href="#telegram-timezone" className="underline">Change timezone</a></p>
      )}
    </section>
  );
}

function TimezonePicker({ state, canMutate, isMutating, pendingOperation, onMutate }: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const current = state.subscriber.quietHours.timezone ?? "UTC";
  const allTimezones = useMemo(() => availableTimezones(), []);
  const allTimezoneSet = useMemo(() => new Set(allTimezones), [allTimezones]);
  const [detectedTimezone, setDetectedTimezone] = useState<string | null>(null);
  const [timezoneUi, setTimezoneUi] = useState({
    confirmed: current,
    recent: [] as string[],
    search: current,
  });
  if (timezoneUi.confirmed !== current) {
    setTimezoneUi({
      confirmed: current,
      recent: [current, ...timezoneUi.recent.filter((zone) => zone !== current)].slice(0, 3),
      search: current,
    });
  }

  useEffect(() => {
    let cancelled = false;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    queueMicrotask(() => {
      if (!cancelled && detected && allTimezoneSet.has(detected)) setDetectedTimezone(detected);
    });
    return () => { cancelled = true; };
  }, [allTimezoneSet]);

  const compactOptions = useMemo(() => {
    const options: Array<{ zone: string; context: string }> = [];
    const add = (zone: string | null, context: string) => {
      if (!zone || (zone !== current && !allTimezoneSet.has(zone)) || options.some((option) => option.zone === zone)) return;
      options.push({ zone, context });
    };
    add(current, "Current");
    add(detectedTimezone, "Detected");
    for (const zone of timezoneUi.recent) add(zone, "Recent");
    for (const zone of COMMON_TIMEZONES) add(zone, "Common");
    return options;
  }, [allTimezoneSet, current, detectedTimezone, timezoneUi.recent]);

  const searchedTimezone = timezoneUi.search.trim();
  const searchIsValid = searchedTimezone === current || allTimezoneSet.has(searchedTimezone);
  const controlsDisabled = !canMutate || isMutating;

  return (
    <section id="telegram-timezone" className="scroll-mt-4 rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Timezone</h2>
        <span className="shrink-0 rounded-md border border-border/60 bg-background/65 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
          {current}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Used for quiet hours and daily recap delivery.</p>
      <label className="sr-only" htmlFor="telegram-mini-app-timezone">Timezone</label>
      <select
        id="telegram-mini-app-timezone"
        className="pharos-focus-ring mt-3 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        value={current}
        disabled={controlsDisabled}
        onChange={(event) => onMutate({ kind: "set-timezone", timezone: event.target.value })}
      >
        {compactOptions.map((option) => (
          <option key={option.zone} value={option.zone}>{option.context}: {option.zone}</option>
        ))}
      </select>
      <details className="mt-3 rounded-lg border border-border/60 bg-background/45 px-3">
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center text-sm font-semibold text-foreground">
          Search all timezones
        </summary>
        <div className="border-t border-border/50 py-3">
          <label htmlFor="telegram-mini-app-timezone-search" className="text-xs font-semibold text-foreground">
            Timezone name
          </label>
          <input
            id="telegram-mini-app-timezone-search"
            type="search"
            list="telegram-mini-app-timezone-options"
            className="pharos-focus-ring mt-2 h-11 w-full rounded-lg border border-border/65 bg-background/70 px-3 text-sm text-foreground placeholder:text-muted-foreground"
            value={timezoneUi.search}
            disabled={controlsDisabled}
            placeholder="Type Europe/Paris"
            autoComplete="off"
            onChange={(event) => setTimezoneUi((existing) => ({ ...existing, search: event.target.value }))}
          />
          <datalist id="telegram-mini-app-timezone-options">
            {allTimezones.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
          {searchedTimezone && !searchIsValid ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" role="status">
              Choose an exact timezone from the search suggestions.
            </p>
          ) : null}
          <div className="mt-3">
            <MiniButton
              disabled={controlsDisabled || !searchIsValid || searchedTimezone === current}
              loading={pendingOperation?.kind === "set-timezone" && pendingOperation.timezone === searchedTimezone}
              onClick={() => onMutate({ kind: "set-timezone", timezone: searchedTimezone })}
            >
              Apply timezone
            </MiniButton>
          </div>
        </div>
      </details>
      <div className="mt-3">
        <MiniButton
          variant="secondary"
          disabled={controlsDisabled || current === "UTC"}
          loading={pendingOperation?.kind === "set-timezone" && pendingOperation.timezone == null}
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
  // bridge escalate. Otherwise fall back to an in-page explicit Arm → Confirm/Cancel
  // flow: the first tap reveals a distinct Confirm/Cancel row so an incidental
  // focus change (no longer wired to onBlur) can never fire the deletion.
  const [forgetArmed, setForgetArmed] = useState(false);
  const [unsubscribeArmed, setUnsubscribeArmed] = useState(false);
  const requiresArming = !hasShowConfirm;

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <h2 className="text-sm font-semibold text-foreground">Danger zone</h2>
      <p className="mt-1 text-xs text-muted-foreground">These actions can&apos;t be undone.</p>
      <div className="mt-3 grid gap-2">
        {requiresArming && unsubscribeArmed ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!canMutate || isMutating}
              aria-label="Confirm unsubscribe from all alerts"
              onClick={() => {
                setUnsubscribeArmed(false);
                onUnsubscribeAll();
              }}
              className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-600/80 bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirm unsubscribe
            </button>
            <MiniButton variant="secondary" disabled={!canMutate || isMutating} onClick={() => setUnsubscribeArmed(false)}>
              Cancel
            </MiniButton>
          </div>
        ) : (
          <MiniButton
            variant="danger"
            disabled={!canMutate || isMutating}
            onClick={() => {
              if (requiresArming) {
                setForgetArmed(false);
                setUnsubscribeArmed(true);
                return;
              }
              onUnsubscribeAll();
            }}
          >
            Unsubscribe from all
          </MiniButton>
        )}
        {requiresArming && forgetArmed ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!canMutate || isMutating}
              aria-label="Confirm delete all my data forever"
              onClick={onForgetMe}
              className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-600/80 bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirm delete forever
            </button>
            <MiniButton variant="secondary" disabled={!canMutate || isMutating} onClick={() => setForgetArmed(false)}>
              Cancel
            </MiniButton>
          </div>
        ) : (
          <MiniButton
            variant="danger"
            ariaLabel="Delete all my data"
            disabled={!canMutate || isMutating}
            onClick={() => {
              if (requiresArming) {
                setUnsubscribeArmed(false);
                setForgetArmed(true);
                return;
              }
              onForgetMe();
            }}
          >
            Delete all my data
          </MiniButton>
        )}
      </div>
    </section>
  );
}

export interface SettingsPanelProps {
  state: TelegramMiniAppState;
  canMutate: boolean;
  canReadPortability: boolean;
  /** A request is in flight. Unlike write lockout, a 429 countdown stays readable. */
  isPortabilityRequestBusy: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  globalAlerts: Record<TelegramAlertType, boolean> & { depegStepBps: TelegramDepegStepBps | null };
  onUnsubscribeAll: () => void;
  onForgetMe: () => void;
  hasShowConfirm: boolean;
  onExportWatchlist: () => Promise<TelegramMiniAppPortabilityResponse | null>;
  onPreviewWatchlistImport: (token: string) => Promise<TelegramMiniAppPortabilityResponse | null>;
  onConfirmWatchlistImport: (operation: Extract<TelegramMiniAppOperation, { kind: "confirm-watchlist-import" }>) => Promise<unknown>;
}

export function SettingsPanel({ state, canMutate, canReadPortability, isMutating, isPortabilityRequestBusy, pendingOperation, onMutate, globalAlerts, onUnsubscribeAll, onForgetMe, hasShowConfirm, onExportWatchlist, onPreviewWatchlistImport, onConfirmWatchlistImport }: SettingsPanelProps) {
  const currentDepegStep = globalAlerts.depegStepBps;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-[color:var(--mini-accent)]" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Global alerts</h2>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Global alert types">
          {(Object.keys(ALERT_LABELS) as TelegramAlertType[]).map((type) => (
            <TogglePill
              key={type}
              label={ALERT_LABELS[type]}
              enabled={globalAlerts[type]}
              disabled={!canMutate || isMutating}
              loading={pendingOperation?.kind === "set-global" && pendingOperation.alertType === type}
              onToggle={() => onMutate({ kind: "set-global", alertType: type, enabled: !globalAlerts[type] })}
            />
          ))}
        </div>
        <div className="mt-5 border-t border-border/60 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Depeg step</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Applies to all-stablecoin depeg alerts.</p>
            </div>
            <span className="pharos-numeric shrink-0 rounded-md border border-border/60 bg-background/65 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
              {currentDepegStep == null ? "Any" : `${currentDepegStep} bps`}
            </span>
          </div>
          <div className="mt-3">
            <SegmentedControl
              ariaLabel="Global depeg step"
              value={currentDepegStep}
              options={DEPEG_STEP_OPTIONS}
              disabled={!canMutate || isMutating}
              getOptionAriaLabel={(option) =>
                option.value == null
                  ? "Set global depeg step to any depeg"
                  : `Set global depeg step to ${option.value} bps`
              }
              onChange={(next) => onMutate({ kind: "set-global-depeg-step", depegStepBps: next })}
            />
          </div>
        </div>
      </section>
      <DailyRecapSection state={state} canMutate={canMutate} isMutating={isMutating} pendingOperation={pendingOperation} onMutate={onMutate} />
      <QuietHoursPicker state={state} canMutate={canMutate} isMutating={isMutating} pendingOperation={pendingOperation} onMutate={onMutate} />
      <TimezonePicker state={state} canMutate={canMutate} isMutating={isMutating} pendingOperation={pendingOperation} onMutate={onMutate} />
      <WatchlistPortabilityPanel
        state={state}
        canMutate={canMutate}
        canReadPortability={canReadPortability}
        isMutating={isPortabilityRequestBusy}
        pendingOperation={pendingOperation}
        onExport={onExportWatchlist}
        onPreview={onPreviewWatchlistImport}
        onConfirm={onConfirmWatchlistImport}
      />
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
