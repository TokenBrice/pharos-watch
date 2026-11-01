"use client";

import { useEffect, useMemo, useState } from "react";
import { Home, Send } from "lucide-react";
import { formatAgo, formatHour } from "../format";
import type { MiniAppScreenProps } from "../types";
import { ListRow, ListSection, SelectRow, Switch } from "./List";

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
const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: formatHour(hour) }));

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

function failureText(failureClass: string | null): string | null {
  if (!failureClass) return null;
  if (failureClass === "blocked" || failureClass === "forbidden") return "Telegram is refusing our messages. Send any message to PharosWatchBot to turn delivery back on.";
  return "The last delivery failed. Alerts retry automatically.";
}

export interface SettingsScreenProps extends MiniAppScreenProps {
  onSendSample?: () => void;
  onAddToHomeScreen?: () => void;
  onUnsubscribeAll: () => void;
  onForgetMe: () => void;
  /** Without native confirm sheets, destructive rows need a second tap. */
  hasShowConfirm: boolean;
  onInvalid: (text: string) => void;
}

export function SettingsScreen({
  state,
  nowSec,
  canEdit,
  busy,
  pendingOperation,
  onMutate,
  onSendSample,
  onAddToHomeScreen,
  onUnsubscribeAll,
  onForgetMe,
  hasShowConfirm,
  onInvalid,
}: SettingsScreenProps) {
  const quiet = state.subscriber.quietHours;
  const start = quiet.startHourUtc ?? 22;
  const end = quiet.endHourUtc ?? 7;
  const controlsDisabled = !canEdit || busy;
  const pendingQuiet = pendingOperation?.kind === "set-quiet-hours" ? pendingOperation : null;
  const [detectedTimezone, setDetectedTimezone] = useState<string | null>(null);
  const [armed, setArmed] = useState<"unsubscribe" | "forget" | null>(null);
  const failure = failureText(state.health.recentFailureClass);

  useEffect(() => {
    let cancelled = false;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    queueMicrotask(() => {
      if (!cancelled && detected) setDetectedTimezone(detected);
    });
    return () => { cancelled = true; };
  }, []);

  const timezoneOptions = useMemo(() => {
    const options: { value: string; label: string; group: string }[] = [];
    const seen = new Set<string>();
    const add = (zone: string | null, group: string, label = zone) => {
      if (!zone || seen.has(zone) || !label) return;
      seen.add(zone);
      options.push({ value: zone, label, group });
    };
    if (quiet.timezone == null) options.push({ value: UNSET_TIMEZONE, label: "Not set (UTC)", group: "Suggested" });
    add(quiet.timezone, "Suggested");
    add(detectedTimezone, "Suggested", detectedTimezone ? `${detectedTimezone} (this device)` : null);
    for (const zone of COMMON_TIMEZONES) add(zone, "Suggested");
    for (const zone of availableTimezones()) add(zone, "All time zones");
    return options;
  }, [detectedTimezone, quiet.timezone]);

  const setHours = (field: "start" | "end", value: number) => {
    const next = { start, end, [field]: value };
    if (next.start === next.end) {
      onInvalid("Quiet hours need different start and end times.");
      return;
    }
    onMutate({ kind: "set-quiet-hours", enabled: true, startHourUtc: next.start, endHourUtc: next.end });
  };

  const armOrRun = (key: "unsubscribe" | "forget", run: () => void) => {
    if (hasShowConfirm || armed === key) {
      setArmed(null);
      run();
      return;
    }
    setArmed(key);
  };

  return (
    <>
      <header className="px-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
      </header>

      <ListSection title="Schedule" className="mt-5" footer={quiet.enabled ? "Hours follow the time zone you pick." : "Pick hours when you don't want messages."}>
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
              value={String(start)}
              options={HOURS}
              disabled={controlsDisabled}
              loading={pendingQuiet?.startHourUtc != null && pendingQuiet.startHourUtc !== quiet.startHourUtc}
              onChange={(next) => setHours("start", Number(next))}
            />
            <SelectRow
              id="quiet-end"
              title="To"
              value={String(end)}
              options={HOURS}
              disabled={controlsDisabled}
              loading={pendingQuiet?.endHourUtc != null && pendingQuiet.endHourUtc !== quiet.endHourUtc}
              onChange={(next) => setHours("end", Number(next))}
            />
          </>
        ) : null}
        <SelectRow
          id="timezone"
          title="Time zone"
          value={quiet.timezone ?? UNSET_TIMEZONE}
          options={timezoneOptions}
          disabled={controlsDisabled}
          loading={pendingOperation?.kind === "set-timezone"}
          onChange={(next) => {
            if (next !== UNSET_TIMEZONE) onMutate({ kind: "set-timezone", timezone: next });
          }}
        />
      </ListSection>

      <ListSection title="Delivery" footer={failure ?? undefined}>
        {state.health.lastSuccessfulDeliveryAt != null ? (
          <ListRow title="Last alert delivered" value={formatAgo(state.health.lastSuccessfulDeliveryAt, nowSec)} />
        ) : null}
        {state.health.lastSuccessfulReplyAt != null ? (
          <ListRow title="Last reply from the bot" value={formatAgo(state.health.lastSuccessfulReplyAt, nowSec)} />
        ) : null}
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
          <ListRow
            title={armed === "unsubscribe" ? "Tap again to unsubscribe from all" : "Unsubscribe from all alerts"}
            tone="destructive"
            disabled={busy}
            loading={pendingOperation?.kind === "unsubscribe-all"}
            onClick={() => armOrRun("unsubscribe", onUnsubscribeAll)}
          />
          <ListRow
            title={armed === "forget" ? "Tap again to delete everything" : "Delete all my data"}
            tone="destructive"
            disabled={busy}
            loading={pendingOperation?.kind === "forget-me"}
            onClick={() => armOrRun("forget", onForgetMe)}
          />
        </ListSection>
      ) : null}
    </>
  );
}
