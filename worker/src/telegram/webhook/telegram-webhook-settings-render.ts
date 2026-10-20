/**
 * Pure render helpers for the /settings inline-keyboard surface (P1-U7).
 * Builders here do not touch D1 or the Telegram API; they return plain text +
 * inline_keyboard payloads consumed by the handlers in
 * `telegram-webhook-settings.ts`.
 */

import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { escapeHtml } from "../delivery/telegram";
import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import { buildTelegramMiniAppUrl } from "../common/mini-app-url";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
} from "@shared/lib/telegram-alert-families";
import {
  formatQuietHours,
  paginateChatRows,
  sortSubscriptions,
} from "./telegram-webhook-messages";
import { unixNow } from "../store/telegram-webhook-store";
import type { SubscriberRow, SubscriptionRow } from "./telegram-webhook-shared";
import type { TelegramAlertType } from "@shared/types/status";
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
  // The step only exists while the depeg family is on: rendering it beside an
  // OFF flag advertises a threshold that is not in force.
  const depegSuffix =
    subscriberHasGlobal(subscriber, "depeg") && subscriber?.global_depeg_worsening_bps_step != null
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
    "<b>Local overrides</b>",
    `DEWS min band: ${escapeHtml(describeDews(row))}`,
    `Safety mode: ${escapeHtml(describeSafety(row))}`,
    `Depeg step: ${escapeHtml(describeDepeg(row))}`,
    `Launch: ${describeLocalState(row, "launch")}`,
    `Reserve: ${describeLocalState(row, "reserve")}`,
    `Freeze alerts: ${describeLocalState(row, "freeze")}`,
    "",
    "Tap a row to set a local override. Inherited coverage follows chat/preset policy; membership is not evaluated here.",
  ].join("\n");
}

export function buildCoinKeyboard(
  coinId: string,
  row: SubscriptionRow | null,
  options: { includeMiniAppButton?: boolean } = {},
): { inline_keyboard: SettingsButton[][] } {
  const dewsBand = row?.alert_dews ? row.dews_min_band ?? "ALERT" : null;
  const safetyMode = row?.alert_safety ? row.safety_mode ?? "all" : null;
  const depegStep: number | "off" | "default" | null = row?.alert_depeg
    ? row.depeg_worsening_bps_step ?? "default"
    : isExplicitOff(row, "depeg") ? "off" : null;
  const plainState = (type: "launch" | "reserve" | "freeze"): boolean | null =>
    row?.[TELEGRAM_ALERT_PERSISTENCE[type].subscriptionColumn] === 1
      ? true
      : isExplicitOff(row, type) ? false : null;

  const rows: SettingsButton[][] = [
    buildDewsRow(coinId, dewsBand, isExplicitOff(row, "dews")),
    buildSafetyRow(coinId, safetyMode, isExplicitOff(row, "safety")),
    buildDepegRow(coinId, depegStep),
    buildPlainAlertRow(coinId, "launch", plainState("launch"), ""),
    buildPlainAlertRow(coinId, "reserve", plainState("reserve")),
    buildPlainAlertRow(coinId, "freeze", plainState("freeze")),
    [{ text: "← Back to chat settings", callback_data: "settings:home" }],
  ];
  if (options.includeMiniAppButton) rows.push([{ text: "Open in app", web_app: { url: buildTelegramMiniAppUrl(`coin_${coinId}`) } }]);
  return { inline_keyboard: rows };
}

// ---------- Row builders ----------

function buildCoinOpenRows(subscriptions: SubscriptionRow[], page: number): SettingsButton[][] {
  if (subscriptions.length === 0) return [];
  const sorted = sortSubscriptions(subscriptions);
  const pageRows = paginateChatRows(sorted, page);
  const rows: SettingsButton[][] = pageRows.rows.map((row) => [
    { text: `${coinLabel(row.stablecoin_id)} settings`, callback_data: `settings:o:${row.stablecoin_id}` },
  ]);

  if (pageRows.totalPages > 1) {
    const nav: SettingsButton[] = [];
    if (pageRows.page > 0) nav.push({ text: "Prev", callback_data: `settings:home:${pageRows.page - 1}` });
    if (pageRows.page < pageRows.totalPages - 1) nav.push({ text: "Next", callback_data: `settings:home:${pageRows.page + 1}` });
    if (nav.length > 0) rows.push(nav);
  }
  return rows;
}

function coinLabel(coinId: string): string {
  return TRACKED_META_BY_ID.get(coinId)?.symbol ?? coinId;
}

function buildDewsRow(coinId: string, dewsBand: string | null, explicitOff: boolean): Array<{ text: string; callback_data: string }> {
  const row = (["A", "W", "D"] as const).map((code) => ({
    text: `${markIf(dewsBand === DEWS_BAND_CODES[code])}${DEWS_BAND_CODES[code]}`,
    callback_data: `settings:c:${coinId}:db:${code}`,
  }));
  row.push({
    text: `${markIf(explicitOff)}off`,
    callback_data: `settings:c:${coinId}:db:0`,
  });
  return row;
}

function buildSafetyRow(coinId: string, safetyMode: string | null, explicitOff: boolean): Array<{ text: string; callback_data: string }> {
  const row = (["a", "d", "u"] as const).map((code) => ({
    text: `${markIf(safetyMode === SAFETY_MODE_CODES[code])}${labelForSafety(code)}`,
    callback_data: `settings:c:${coinId}:sm:${code}`,
  }));
  row.push({
    text: `${markIf(explicitOff)}off`,
    callback_data: `settings:c:${coinId}:sm:0`,
  });
  return row;
}

function buildPlainAlertRow(
  coinId: string,
  alertType: "launch" | "reserve" | "freeze",
  enabled: boolean | null,
  prefix = `${TELEGRAM_ALERT_FAMILY_SHORT_LABELS[alertType]} `,
): Array<{ text: string; callback_data: string }> {
  const code = TELEGRAM_ALERT_PERSISTENCE[alertType].settingCode;
  return [
    { text: `${prefix}${markIf(enabled === true)}on`, callback_data: `settings:c:${coinId}:${code}:1` },
    { text: `${markIf(enabled === false)}off`, callback_data: `settings:c:${coinId}:${code}:0` },
  ];
}

function buildDepegRow(
  coinId: string,
  depegStep: number | "off" | "default" | null,
): Array<{ text: string; callback_data: string }> {
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

function isExplicitOff(row: SubscriptionRow | null, type: TelegramAlertType): boolean {
  const { subscriptionColumn, overrideColumn } = TELEGRAM_ALERT_PERSISTENCE[type];
  return row?.[subscriptionColumn] === 0 && row[overrideColumn] === 1;
}

function describeLocalState(row: SubscriptionRow | null, type: TelegramAlertType): string {
  if (row?.[TELEGRAM_ALERT_PERSISTENCE[type].subscriptionColumn] === 1) return "on";
  if (isExplicitOff(row, type)) return "off (local override)";
  return type === "dews" || type === "depeg" || type === "safety"
    ? "inherits chat/preset policy"
    : "inherits chat policy";
}

function describeDews(row: SubscriptionRow | null): string {
  if (!row?.alert_dews) return describeLocalState(row, "dews");
  return row.dews_min_band ?? "ALERT";
}

function describeSafety(row: SubscriptionRow | null): string {
  if (!row?.alert_safety) return describeLocalState(row, "safety");
  return row.safety_mode ?? "all";
}

function describeDepeg(row: SubscriptionRow | null): string {
  if (!row?.alert_depeg) return describeLocalState(row, "depeg");
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
