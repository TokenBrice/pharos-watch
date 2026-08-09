/**
 * Pure render helpers for the /settings inline-keyboard surface (P1-U7).
 * Builders here do not touch D1 or the Telegram API; they return plain text +
 * inline_keyboard payloads consumed by the handlers in
 * `telegram-webhook-settings.ts`.
 */

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { escapeHtml } from "../lib/telegram";
import { isPausedSentinel } from "../lib/telegram-constants";
import { buildTelegramMiniAppUrl } from "../lib/telegram-webhook-registration";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
} from "@shared/lib/telegram-alert-families";
import { MANAGE_PAGE_SIZE, formatQuietHours } from "./telegram-webhook-messages";
import { unixNow } from "./telegram-webhook-store";
import type { SubscriberRow, SubscriptionRow } from "./telegram-webhook-shared";
import {
  DEPEG_STEPS,
  DEWS_BAND_CODES,
  GLOBAL_ALERT_TYPES,
  SAFETY_MODE_CODES,
  subscriberHasGlobal,
  type GlobalAlertType,
  type SafetyModeCode,
} from "./telegram-webhook-settings-shared";

export function buildHomeMessage(
  subscriber: SubscriberRow | null,
  options: { hasCoinControls?: boolean } = {},
): string {
  const depegSuffix =
    subscriber?.global_depeg_worsening_bps_step != null
      ? ` (+${subscriber.global_depeg_worsening_bps_step}bps)`
      : "";
  const lines = [
    "<b>Settings</b>",
    "",
    `Quiet hours: ${formatQuietHoursLine(subscriber)}`,
    `Snooze: ${formatSnoozeLine(subscriber)}`,
    "",
    "<b>Global alerts</b>",
    // Generated from GLOBAL_ALERT_TYPES so the state lines always match the
    // toggle rows `buildHomeKeyboard` renders from the same list. The previous
    // hand-written four missed Reserve and Freeze entirely.
    ...GLOBAL_ALERT_TYPES.map(
      (type) =>
        `${labelForType(type)}: ${subscriberHasGlobal(subscriber, type) ? "ON" : "OFF"}${
          type === "depeg" ? depegSuffix : ""
        }`,
    ),
    "",
    options.hasCoinControls
      ? "Tap a row to toggle. Tap a coin below or send /settings &lt;ticker&gt; for per-coin controls."
      : "Tap a row to toggle. For a per-coin view send /settings &lt;ticker&gt;.",
  ];
  return lines.join("\n");
}

type SettingsButton = { text: string; callback_data?: string; web_app?: { url: string } };

interface HomeKeyboardOptions {
  includeMiniAppButton?: boolean;
  subscriptions?: SubscriptionRow[];
  subscriptionPage?: number;
}

export function buildHomeKeyboard(subscriber: SubscriberRow | null, options: HomeKeyboardOptions = {}): {
  inline_keyboard: SettingsButton[][];
} {
  const quietOn = Boolean(subscriber?.quiet_hours_enabled);
  const snoozeActive = (subscriber?.alert_snooze_until_ts ?? 0) > unixNow();
  const paused = isPausedSentinel(subscriber?.alert_snooze_until_ts ?? null);
  const rows: SettingsButton[][] = [
    [
      {
        text: `Quiet hours: ${quietOn ? "ON" : "OFF"}`,
        callback_data: `settings:q:${quietOn ? "0" : "1"}`,
      },
    ],
  ];
  if (snoozeActive) {
    rows.push([
      { text: paused ? "Resume alerts" : "Clear snooze", callback_data: "settings:sc" },
    ]);
  }
  for (const type of GLOBAL_ALERT_TYPES) {
    rows.push([
      {
        text: `${labelForType(type)}: ${subscriberHasGlobal(subscriber, type) ? "ON" : "OFF"}`,
        callback_data: `settings:gt:${type}`,
      },
    ]);
  }
  rows.push(...buildCoinOpenRows(options.subscriptions ?? [], options.subscriptionPage ?? 0));
  if (options.includeMiniAppButton) {
    rows.push([{ text: "Open in app", web_app: { url: buildTelegramMiniAppUrl("settings") } }]);
  }
  return { inline_keyboard: rows };
}

export function buildCoinMessage(coinId: string, row: SubscriptionRow | null): string {
  const meta = TRACKED_META_BY_ID.get(coinId);
  const symbol = meta?.symbol ?? coinId;
  return [
    `<b>${escapeHtml(symbol)} settings</b>`,
    "",
    `DEWS min band: ${escapeHtml(describeDews(row))}`,
    `Safety mode: ${escapeHtml(describeSafety(row))}`,
    `Depeg step: ${escapeHtml(describeDepeg(row))}`,
    `Launch: ${row?.alert_launch ? "on" : "off"}`,
    `Reserve: ${row?.alert_reserve ? "on" : "off"}`,
    `Freeze alerts: ${row?.alert_freeze ? "on" : "off"}`,
    "",
    "Tap a row to change.",
  ].join("\n");
}

export function buildCoinKeyboard(
  coinId: string,
  row: SubscriptionRow | null,
  options: { includeMiniAppButton?: boolean } = {},
): { inline_keyboard: SettingsButton[][] } {
  const dewsBand = row?.alert_dews ? row?.dews_min_band ?? "ALERT" : null;
  const safetyMode = row?.alert_safety ? row?.safety_mode ?? "all" : null;
  const depegStep: number | "off" = row?.alert_depeg ? row?.depeg_worsening_bps_step ?? -1 : "off";
  const launchOn = Boolean(row?.alert_launch);
  const reserveOn = Boolean(row?.alert_reserve);
  const freezeOn = Boolean(row?.alert_freeze);

  const rows: SettingsButton[][] = [
    buildDewsRow(coinId, dewsBand),
    buildSafetyRow(coinId, safetyMode),
    buildDepegRow(coinId, depegStep),
    // The launch row predates the family prefix and stays unprefixed.
    buildPlainAlertRow(coinId, "launch", launchOn, ""),
    buildPlainAlertRow(coinId, "reserve", reserveOn),
    buildPlainAlertRow(coinId, "freeze", freezeOn),
    [{ text: "← Back to chat settings", callback_data: "settings:home" }],
  ];
  if (options.includeMiniAppButton) rows.push([{ text: "Open in app", web_app: { url: buildTelegramMiniAppUrl(`coin_${coinId}`) } }]);
  return { inline_keyboard: rows };
}

// ---------- Row builders ----------

function buildCoinOpenRows(subscriptions: SubscriptionRow[], page: number): SettingsButton[][] {
  if (subscriptions.length === 0) return [];
  const sorted = [...subscriptions].sort((a, b) => coinLabel(a.stablecoin_id).localeCompare(coinLabel(b.stablecoin_id)));
  const totalPages = Math.max(1, Math.ceil(sorted.length / MANAGE_PAGE_SIZE));
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = clampedPage * MANAGE_PAGE_SIZE;
  const rows: SettingsButton[][] = sorted.slice(start, start + MANAGE_PAGE_SIZE).map((row) => [
    { text: `${coinLabel(row.stablecoin_id)} settings`, callback_data: `settings:o:${row.stablecoin_id}` },
  ]);

  if (totalPages > 1) {
    const nav: SettingsButton[] = [];
    if (clampedPage > 0) nav.push({ text: "Prev", callback_data: `settings:home:${clampedPage - 1}` });
    if (clampedPage < totalPages - 1) nav.push({ text: "Next", callback_data: `settings:home:${clampedPage + 1}` });
    if (nav.length > 0) rows.push(nav);
  }
  return rows;
}

function coinLabel(coinId: string): string {
  return TRACKED_META_BY_ID.get(coinId)?.symbol ?? coinId;
}

function buildDewsRow(coinId: string, dewsBand: string | null): Array<{ text: string; callback_data: string }> {
  const row = (["A", "W", "D"] as const).map((code) => ({
    text: `${markIf(dewsBand === DEWS_BAND_CODES[code])}${DEWS_BAND_CODES[code]}`,
    callback_data: `settings:c:${coinId}:db:${code}`,
  }));
  row.push({
    text: `${markIf(dewsBand == null)}off`,
    callback_data: `settings:c:${coinId}:db:0`,
  });
  return row;
}

function buildSafetyRow(coinId: string, safetyMode: string | null): Array<{ text: string; callback_data: string }> {
  const row = (["a", "d", "u"] as const).map((code) => ({
    text: `${markIf(safetyMode === SAFETY_MODE_CODES[code])}${labelForSafety(code)}`,
    callback_data: `settings:c:${coinId}:sm:${code}`,
  }));
  row.push({
    text: `${markIf(safetyMode == null)}off`,
    callback_data: `settings:c:${coinId}:sm:0`,
  });
  return row;
}

function buildPlainAlertRow(
  coinId: string,
  alertType: "launch" | "reserve" | "freeze",
  enabled: boolean,
  prefix = `${TELEGRAM_ALERT_FAMILY_SHORT_LABELS[alertType]} `,
): Array<{ text: string; callback_data: string }> {
  const code = TELEGRAM_ALERT_PERSISTENCE[alertType].settingCode;
  return [
    { text: `${prefix}${markIf(enabled)}on`, callback_data: `settings:c:${coinId}:${code}:1` },
    { text: `${markIf(!enabled)}off`, callback_data: `settings:c:${coinId}:${code}:0` },
  ];
}

function buildDepegRow(coinId: string, depegStep: number | "off"): Array<{ text: string; callback_data: string }> {
  const row = DEPEG_STEPS.map((step) => ({
    text: `${markIf(depegStep === step)}${step}`,
    callback_data: `settings:c:${coinId}:ds:${step}`,
  }));
  row.push({
    text: `${markIf(depegStep === "off")}off`,
    callback_data: `settings:c:${coinId}:ds:0`,
  });
  return row;
}

// ---------- Small helpers ----------

function labelForType(type: GlobalAlertType): string {
  return TELEGRAM_ALERT_FAMILY_SHORT_LABELS[type];
}

const SAFETY_LABELS: Record<SafetyModeCode, string> = {
  a: "all",
  d: "downgrade",
  u: "upgrade",
};

function labelForSafety(code: SafetyModeCode): string {
  return SAFETY_LABELS[code];
}

function markIf(active: boolean): string {
  return active ? "• " : "";
}

function describeDews(row: SubscriptionRow | null): string {
  if (!row?.alert_dews) return "off";
  return row.dews_min_band ?? "ALERT";
}

function describeSafety(row: SubscriptionRow | null): string {
  if (!row?.alert_safety) return "off";
  return row.safety_mode ?? "all";
}

function describeDepeg(row: SubscriptionRow | null): string {
  if (!row?.alert_depeg) return "off";
  return row.depeg_worsening_bps_step != null ? `+${row.depeg_worsening_bps_step}bps` : "on (no step)";
}

function formatQuietHoursLine(subscriber: SubscriberRow | null): string {
  if (!subscriber?.quiet_hours_enabled) return "off";
  const start = subscriber.quiet_hours_start_utc;
  const end = subscriber.quiet_hours_end_utc;
  if (start == null || end == null) return "off";
  return formatQuietHours(start, end, subscriber.timezone);
}

function formatSnoozeLine(subscriber: SubscriberRow | null): string {
  const until = subscriber?.alert_snooze_until_ts ?? null;
  if (until == null) return "off";
  if (isPausedSentinel(until)) return "Paused (indefinite)";
  const remaining = until - unixNow();
  if (remaining <= 0) return "off";
  if (remaining < 90 * 60) return `${Math.round(remaining / 60)} min`;
  if (remaining < 48 * 3600) return `${Math.round(remaining / 3600)} h`;
  return `${Math.round(remaining / 86400)} d`;
}
