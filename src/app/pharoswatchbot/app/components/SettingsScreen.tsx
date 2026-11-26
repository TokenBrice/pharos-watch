"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Home, Send } from "lucide-react";
import {
  isPausedSentinel,
  isTelegramBlockedFailureClass,
  isTelegramSnoozeActive,
} from "@shared/lib/telegram-delivery-policy";
import {
  DAILY_CHANGES_HOUR,
  SNOOZE_DURATION_LABELS,
  SNOOZE_DURATION_TOKENS,
} from "../constants";
import {
  formatAgo,
  formatClock,
  formatHour,
  formatTimeZoneCity,
  hasAnyCoverage,
} from "../format";
import type { MiniAppScreenProps } from "../types";
import { ChoiceChips, ListRow, ListSection, SelectRow, Switch } from "./List";

const COMMON_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;
const UNSET_TIMEZONE = "__unset__";
const HOUR_VALUES = Array.from({ length: 24 }, (_, hour) => hour);
const DESTRUCTIVE_ARM_TIMEOUT_MS = 8_000;

function availableTimezones(): readonly string[] {
  // `Intl.supportedValuesOf` is ES2022 and not yet in the lib.dom types we target, so probe via an unknown cast.
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const values = intl.supportedValuesOf?.("timeZone");
    if (Array.isArray(values) && values.length > 0) return values;
  } catch {
    // fall through to the common list
  }
  return COMMON_TIMEZONES;
}

export interface SettingsScreenProps extends MiniAppScreenProps {
  onPause: () => void;
  onSendSample?: () => void;
  onAddToHomeScreen?: () => void;
  onUnsubscribeAll: () => void;
  onForgetMe: () => void;
  /** Native confirm available for unsubscribe-all. */
  hasShowConfirm: boolean;
  /** Native destructive popup or confirm available for forget-me. */
  hasForgetConfirm: boolean;
  onInvalid: (text: string) => void;
}

export function SettingsScreen({
  state,
  nowSec,
  canEdit,
  busy,
  pendingOperation,
  onMutate,
  onPause,
  onSendSample,
  onAddToHomeScreen,
  onUnsubscribeAll,
  onForgetMe,
  hasShowConfirm,
  hasForgetConfirm,
  onInvalid,
}: SettingsScreenProps) {
  const quiet = state.subscriber.quietHours;
  const start = quiet.startHourUtc ?? 22;
  const end = quiet.endHourUtc ?? 7;
  const controlsDisabled = !canEdit || busy;
  const pendingQuiet = pendingOperation?.kind === "set-quiet-hours" ? pendingOperation : null;
  const [detectedTimezone, setDetectedTimezone] = useState<string | null>(null);
  const [armed, setArmed] = useState<"unsubscribe" | "forget" | null>(null);

  const snoozeUntil = state.subscriber.snoozeUntilTs;
  const snoozed = snoozeUntil != null && isTelegramSnoozeActive(snoozeUntil, nowSec);
  const failureClass = state.health.recentFailureClass;
  const isBlocked = isTelegramBlockedFailureClass(failureClass);
  const hasCoverage = hasAnyCoverage(state);

  useEffect(() => {
    let cancelled = false;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    queueMicrotask(() => {
      if (!cancelled && detected) setDetectedTimezone(detected);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(null), DESTRUCTIVE_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const timezoneOptions = useMemo(() => {
    const options: { value: string; label: string; group: string }[] = [];
    const seen = new Set<string>();
    const add = (zone: string | null, group: string, label = zone) => {
      if (!zone || seen.has(zone) || !label) return;
      seen.add(zone);
      options.push({ value: zone, label, group });
    };
    if (quiet.timezone == null) options.push({ value: UNSET_TIMEZONE, label: "UTC (not set)", group: "Suggested" });
    add(quiet.timezone, "Suggested");
    add(detectedTimezone, "Suggested", detectedTimezone ? `${detectedTimezone} (this device)` : null);
    for (const zone of COMMON_TIMEZONES) add(zone, "Suggested");
    for (const zone of availableTimezones()) add(zone, "All time zones");
    return options;
  }, [detectedTimezone, quiet.timezone]);

  const fromHourOptions = useMemo(
    () => HOUR_VALUES.map((hour) => ({
      value: String(hour),
      label: hour === end ? `${formatHour(hour)} (same as To)` : formatHour(hour),
      disabled: hour === end,
    })),
    [end],
  );

  const toHourOptions = useMemo(
    () => HOUR_VALUES.map((hour) => ({
      value: String(hour),
      label: hour === start ? `${formatHour(hour)} (same as From)` : formatHour(hour),
      disabled: hour === start,
    })),
    [start],
  );

  const setHours = useCallback((field: "start" | "end", value: number) => {
    const next = { start, end, [field]: value };
    if (next.start === next.end) {
      onInvalid("Quiet hours need different start and end times.");
      return;
    }
    onMutate({ kind: "set-quiet-hours", enabled: true, startHourUtc: next.start, endHourUtc: next.end });
  }, [end, onInvalid, onMutate, start]);

  const handleTimezoneChange = useCallback((next: string) => {
    if (next !== UNSET_TIMEZONE) onMutate({ kind: "set-timezone", timezone: next });
  }, [onMutate]);

  const handleStartHourChange = useCallback((next: string) => {
    setHours("start", Number(next));
  }, [setHours]);

  const handleEndHourChange = useCallback((next: string) => {
    setHours("end", Number(next));
  }, [setHours]);

  const armOrRun = (key: "unsubscribe" | "forget", hasNativeDialog: boolean, run: () => void) => {
    if (hasNativeDialog || armed === key) {
      setArmed(null);
      run();
      return;
    }
    setArmed(key);
  };

  const deliveryFooter = [
    state.health.diagnosticsAvailable === false ? "Delivery status can't be read right now." : null,
    failureClass && !isBlocked ? "The last delivery failed." : null,
  ].filter(Boolean).join(" ") || undefined;

  const scheduleFooter = quiet.enabled
    ? `Alerts still arrive from ${formatHour(start)} to ${formatHour(end)}, without sound. The daily Changes message waits until ${formatHour(end)}. To stop alerts, pause them.`
    : "Quiet hours deliver alerts without sound. They do not stop them.";

  return (
    <>
      <header className="px-1 pt-2">
        <h1 tabIndex={-1} className="outline-none text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
      </header>

      <ListSection title="Alerts" className="mt-5">
        {snoozed && snoozeUntil != null ? (
          <ListRow
            wrap
            title={isPausedSentinel(snoozeUntil)
              ? "Paused until you resume"
              : <>Paused until <span className="tabular-nums">{formatClock(snoozeUntil, quiet.timezone, nowSec)}</span></>}
            trailing={(
              <ChoiceChips
                label="Resume alerts"
                options={[{ value: "resume", label: "Resume" }]}
                disabled={controlsDisabled}
                pendingValue={pendingOperation?.kind === "clear-snooze" ? "resume" : null}
                onSelect={() => onMutate({ kind: "clear-snooze" })}
              />
            )}
          />
        ) : (
          <>
            <ListRow
              wrap
              title="Pause all alerts"
              trailing={(
                <ChoiceChips
                  label="Pause all alerts"
                  options={SNOOZE_DURATION_TOKENS.map((token) => ({
                    value: token,
                    label: token,
                    ariaLabel: `Pause all alerts for ${SNOOZE_DURATION_LABELS[token]}`,
                  }))}
                  disabled={controlsDisabled}
                  pendingValue={pendingOperation?.kind === "set-snooze" ? pendingOperation.durationToken : null}
                  onSelect={(token) => onMutate({ kind: "set-snooze", durationToken: token })}
                />
              )}
            />
            <ListRow
              title="Pause until I resume"
              disabled={controlsDisabled}
              loading={pendingOperation?.kind === "pause"}
              onClick={onPause}
            />
          </>
        )}
      </ListSection>

      <ListSection title="Schedule" footer={scheduleFooter}>
        {quiet.timezone == null && detectedTimezone && canEdit ? (
          <ListRow
            title="Use this device's time zone"
            value={formatTimeZoneCity(detectedTimezone)}
            tone="accent"
            disabled={controlsDisabled}
            loading={pendingOperation?.kind === "set-timezone"}
            onClick={() => onMutate({ kind: "set-timezone", timezone: detectedTimezone })}
          />
        ) : null}
        <SelectRow
          id="timezone"
          title="Time zone"
          subtitle={`Sets quiet hours and the ${DAILY_CHANGES_HOUR} daily Changes message`}
          value={quiet.timezone ?? UNSET_TIMEZONE}
          options={timezoneOptions}
          disabled={controlsDisabled}
          loading={pendingOperation?.kind === "set-timezone"}
          onChange={handleTimezoneChange}
        />
        <ListRow
          title="Quiet hours"
          trailing={(
            <Switch
              label="Quiet hours"
              checked={quiet.enabled}
              disabled={controlsDisabled}
              loading={pendingQuiet != null && pendingQuiet.startHourUtc == null}
              onChange={(next) => onMutate({ kind: "set-quiet-hours", enabled: next })}
            />
          )}
        />
        {quiet.enabled ? (
          <>
            <SelectRow
              id="quiet-start"
              title="From"
              numericValue
              value={String(start)}
              options={fromHourOptions}
              disabled={controlsDisabled}
              loading={pendingQuiet?.startHourUtc != null && pendingQuiet.startHourUtc !== quiet.startHourUtc}
              onChange={handleStartHourChange}
            />
            <SelectRow
              id="quiet-end"
              title="To"
              numericValue
              value={String(end)}
              options={toHourOptions}
              disabled={controlsDisabled}
              loading={pendingQuiet?.endHourUtc != null && pendingQuiet.endHourUtc !== quiet.endHourUtc}
              onChange={handleEndHourChange}
            />
          </>
        ) : null}
      </ListSection>

      <ListSection title="Delivery" footer={deliveryFooter}>
        {isBlocked ? (
          <ListRow
            leading={<span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-state-danger-solid" />}
            title="Telegram stopped delivering alerts"
            subtitle="Open the chat and tap Start (or send /status) to resume delivery."
          />
        ) : null}
        {state.health.diagnosticsAvailable === false ? (
          <>
            <ListRow title="Last alert delivered" value="—" />
            <ListRow title="Last reply from the bot" value="—" />
          </>
        ) : (
          <>
            <ListRow
              title="Last alert delivered"
              value={<span className="tabular-nums">{formatAgo(state.health.lastSuccessfulDeliveryAt, nowSec)}</span>}
            />
            <ListRow
              title="Last reply from the bot"
              value={<span className="tabular-nums">{formatAgo(state.health.lastSuccessfulReplyAt, nowSec)}</span>}
            />
          </>
        )}
        {state.health.queuedAlerts > 0 ? (
          <ListRow title="Waiting to send" value={<span className="pharos-numeric">{state.health.queuedAlerts}</span>} />
        ) : null}
        {onSendSample ? (
          <ListRow
            title="Send a sample alert"
            tone="accent"
            leading={<Send className="h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />}
            onClick={onSendSample}
          />
        ) : null}
        {onAddToHomeScreen ? (
          <ListRow
            title="Add to home screen"
            tone="accent"
            leading={<Home className="h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />}
            onClick={onAddToHomeScreen}
          />
        ) : null}
      </ListSection>

      {canEdit ? (
        <ListSection
          title="Your data"
          footer="Delete removes your coins, presets and settings from Pharos. Sending /forget in the chat does the same."
        >
          {hasCoverage ? (
            <ListRow
              title={armed === "unsubscribe" ? "Tap again to unsubscribe from all" : "Unsubscribe from all alerts"}
              subtitle="Keeps your account, clears what you follow"
              tone="destructive"
              disabled={busy}
              loading={pendingOperation?.kind === "unsubscribe-all"}
              onClick={() => armOrRun("unsubscribe", hasShowConfirm, onUnsubscribeAll)}
            />
          ) : null}
          <ListRow
            title={armed === "forget" ? "Tap again to delete everything" : "Delete all my data"}
            subtitle="Removes everything Pharos stores about you"
            tone="destructive"
            disabled={busy}
            loading={pendingOperation?.kind === "forget-me"}
            onClick={() => armOrRun("forget", hasForgetConfirm, onForgetMe)}
          />
        </ListSection>
      ) : null}
    </>
  );
}
