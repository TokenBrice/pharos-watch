/**
 * Pure render helpers for the Group `/settings` inline-keyboard surface.
 * Builders here do not touch D1 or the Telegram API; they return HTML text +
 * inline_keyboard payloads consumed by `telegram-webhook-settings.ts`.
 */

import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
} from "@shared/lib/telegram-mini-app-contract";
import { escapeHtml } from "../delivery/telegram";
import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import { buildTelegramMiniAppUrl } from "../common/mini-app-url";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
  TELEGRAM_PRESET_ALERT_TYPES,
  DEWS_BAND_CODE_BY_VALUE,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_PRESET_LABEL_BY_ID, type TelegramPresetId } from "../common/presets";
import {
  cmdForChat,
  describeGlobalAlertSettings,
  describePresetSubscriptionSettings,
  formatDepegStepPercent,
  formatDewsCompactBand,
  formatQuietHours,
  formatSnoozeDuration,
  paginateChatRows,
  quietHoursTimezoneLabel,
  sortSubscriptions,
} from "./telegram-webhook-messages";
import { unixNow } from "../store/subscribers";
import type { PresetSubscriptionRow, SubscriberRow, SubscriptionRow } from "./telegram-webhook-shared";
import {
  TELEGRAM_DEWS_BANDS,
  TELEGRAM_DEPEG_STEPS,
  type TelegramAlertType,
} from "@shared/types/status/telegram";
import {
  GLOBAL_ALERT_TYPES,
  SETTINGS_COINS_PAGE_SIZE,
  SETTINGS_PRESET_CODE_BY_FAMILY,
  subscriberHasGlobal,
  type GlobalAlertType,
} from "./telegram-webhook-settings-shared";

export type SettingsButton = { text: string; callback_data?: string; web_app?: { url: string } };

interface HomeRenderOptions {
  includeMiniAppButton?: boolean;
  subscriptions?: SubscriptionRow[];
  presetSubscriptions?: PresetSubscriptionRow[];
  subscriptionPage?: number;
  chatType?: string;
}

export function buildHomeMessage(
  subscriber: SubscriberRow | null,
  options: {
    hasCoinControls?: boolean;
    presetSubscriptions?: PresetSubscriptionRow[];
    chatType?: string;
  } = {},
): string {
  const chatType = options.chatType ?? "group";
  const settingsCmd = cmdForChat("settings", chatType);
  const presets = options.presetSubscriptions ?? [];
  const presetSummary = presets.length > 0
    ? presets
        .map((row) => `${presetLabel(row.preset_id)} (${describePresetSubscriptionSettings(row)})`)
        .join(", ")
    : "None";
  const globalSummary = describeGlobalAlertSettings(subscriber);
  const lines = [
    "<b>Settings</b>",
    "",
    `Quiet hours: ${escapeHtml(formatQuietHoursLine(subscriber))}`,
    `Alerts: ${escapeHtml(formatAlertsPauseLine(subscriber))}`,
    `Presets: ${escapeHtml(presetSummary)}`,
    `All stablecoins: ${escapeHtml(globalSummary === "None" ? "Off" : globalSummary)}`,
    "",
    options.hasCoinControls
      ? `Tap a button below to edit. Tap a coin or send ${escapeHtml(settingsCmd)} &lt;ticker&gt; for per-coin controls.`
      : `Tap a button below to edit. For a per-coin view send ${escapeHtml(settingsCmd)} &lt;ticker&gt;.`,
  ];
  return lines.join("\n");
}

export function buildHomeKeyboard(
  subscriber: SubscriberRow | null,
  options: HomeRenderOptions = {},
): {
  inline_keyboard: SettingsButton[][];
} {
  const quietOn = Boolean(subscriber?.quiet_hours_enabled);
  const snoozeActive = (subscriber?.alert_snooze_until_ts ?? 0) > unixNow();
  const pageRows = paginateChatRows(
    sortSubscriptions(options.subscriptions ?? []),
    options.subscriptionPage ?? 0,
    SETTINGS_COINS_PAGE_SIZE,
  );
  const currentPage = pageRows.page;
  const rows: SettingsButton[][] = [
    [
      {
        text: `Quiet hours: ${quietOn ? "ON" : "OFF"} (${formatSavedQuietWindow(subscriber)})`,
        callback_data: `settings:q:${quietOn ? "0" : "1"}`,
      },
    ],
  ];
  if (snoozeActive) {
    rows.push([{ text: "Resume alerts", callback_data: "settings:sn:off" }]);
  } else {
    rows.push([
      { text: "Pause 4h", callback_data: "settings:sn:4h" },
      { text: "Pause 24h", callback_data: "settings:sn:24h" },
      { text: "Pause all", callback_data: "settings:sn:pause" },
    ]);
  }
  for (const preset of options.presetSubscriptions ?? []) {
    const label = presetLabel(preset.preset_id);
    const families = describePresetSubscriptionSettings(preset);
    rows.push([
      {
        text: `${label} (${families}) ▸`,
        callback_data: `settings:p:${preset.preset_id}:${currentPage}`,
      },
    ]);
  }
  const activeGlobalCount = GLOBAL_ALERT_TYPES.filter((type) => subscriberHasGlobal(subscriber, type)).length;
  rows.push([
    {
      text: `All stablecoins: ${activeGlobalCount > 0 ? `${activeGlobalCount} on` : "Off"} ▸`,
      callback_data: `settings:g:${currentPage}`,
    },
  ]);
  rows.push(...buildCoinGridRows(pageRows));
  if (options.includeMiniAppButton) {
    rows.push([{ text: "Open in app", web_app: { url: buildTelegramMiniAppUrl("settings") } }]);
  }
  return { inline_keyboard: rows };
}

export function buildGlobalMessage(subscriber: SubscriberRow | null): string {
  // The step only exists while the depeg family is on: rendering it beside an
  // OFF flag advertises a threshold that is not in force.
  const depegSuffix =
    subscriberHasGlobal(subscriber, "depeg") && subscriber?.global_depeg_worsening_bps_step != null
      ? ` (${formatDepegStepPercent(subscriber.global_depeg_worsening_bps_step)})`
      : "";
  const statusLine = (type: GlobalAlertType): string =>
    `${labelForType(type)}: ${subscriberHasGlobal(subscriber, type) ? "ON" : "OFF"}${
      type === "depeg" ? depegSuffix : ""
    }`;
  return [
    "<b>All stablecoins</b>",
    "Applies to every active stablecoin unless overridden per coin.",
    "",
    "<b>Daily summary only</b>",
    statusLine("dews"),
    statusLine("safety"),
    "",
    "<b>Live alerts</b>",
    statusLine("depeg"),
    statusLine("reserve"),
    statusLine("freeze"),
  ].join("\n");
}

export function buildGlobalKeyboard(
  subscriber: SubscriberRow | null,
  returnPage = 0,
): {
  inline_keyboard: SettingsButton[][];
} {
  const rows: SettingsButton[][] = GLOBAL_ALERT_TYPES.map((type) => [
    {
      text: `${labelForType(type)}: ${subscriberHasGlobal(subscriber, type) ? "ON" : "OFF"}`,
      // The button names the target value so a redelivered tap cannot flip it back.
      callback_data: `settings:gt:${type}:${subscriberHasGlobal(subscriber, type) ? "0" : "1"}:${returnPage}`,
    },
  ]);
  rows.push([{ text: "← Back to settings", callback_data: `settings:home:${returnPage}` }]);
  return { inline_keyboard: rows };
}

export function buildPresetMessage(presetId: TelegramPresetId, row: PresetSubscriptionRow | null): string {
  const label = escapeHtml(presetLabel(presetId));
  if (!row) {
    return [
      `<b>${label}</b> (preset)`,
      "",
      "This chat does not follow this preset.",
    ].join("\n");
  }
  const depegSuffix = row.alert_depeg && row.depeg_worsening_bps_step != null
    ? ` (${formatDepegStepPercent(row.depeg_worsening_bps_step)})`
    : "";
  return [
    `<b>${label}</b> (preset)`,
    "",
    `DEWS: ${row.alert_dews ? "ON" : "OFF"}`,
    `Depeg: ${row.alert_depeg ? "ON" : "OFF"}${depegSuffix}`,
    `Safety: ${row.alert_safety ? "ON" : "OFF"}`,
    "",
    "Reserve drift and Freezes are set per coin.",
  ].join("\n");
}

export function buildPresetKeyboard(
  presetId: TelegramPresetId,
  row: PresetSubscriptionRow | null,
  returnPage = 0,
): { inline_keyboard: SettingsButton[][] } {
  const rows: SettingsButton[][] = [];
  if (row) {
    rows.push(
      TELEGRAM_PRESET_ALERT_TYPES.map((family) => {
        const enabled = row[TELEGRAM_ALERT_PERSISTENCE[family].subscriptionColumn] === 1;
        const code = SETTINGS_PRESET_CODE_BY_FAMILY[family];
        return {
          text: `${TELEGRAM_ALERT_FAMILY_SHORT_LABELS[family]}: ${enabled ? "ON" : "OFF"}`,
          callback_data: `settings:pf:${presetId}:${code}:${enabled ? "0" : "1"}:${returnPage}`,
        };
      }),
    );
    rows.push([
      {
        text: `Unfollow ${presetLabel(presetId)}`,
        callback_data: `settings:pu:${presetId}:${returnPage}`,
      },
    ]);
  }
  rows.push([{ text: "← Back to settings", callback_data: `settings:home:${returnPage}` }]);
  return { inline_keyboard: rows };
}

export function buildPresetUnfollowConfirmMessage(presetId: TelegramPresetId): string {
  return [
    `<b>Unfollow ${escapeHtml(presetLabel(presetId))}?</b>`,
    "This chat will stop getting alerts from this preset. Coins followed directly are unchanged.",
  ].join("\n");
}

export function buildPresetUnfollowConfirmKeyboard(
  presetId: TelegramPresetId,
  returnPage = 0,
): { inline_keyboard: SettingsButton[][] } {
  return {
    inline_keyboard: [[
      { text: `Unfollow ${presetLabel(presetId)}`, callback_data: `settings:pc:${presetId}:${returnPage}` },
      { text: "Cancel", callback_data: `settings:p:${presetId}:${returnPage}` },
    ]],
  };
}

export function buildCoinMessage(coinId: string, row: SubscriptionRow | null): string {
  const meta = TRACKED_META_BY_ID.get(coinId);
  const symbol = meta?.symbol ?? coinId;
  return [
    `<b>${escapeHtml(symbol)} settings</b>`,
    "",
    "<b>Local overrides</b>",
    `DEWS: ${escapeHtml(describeDews(row))}`,
    `Depeg: ${escapeHtml(describeDepeg(row))}`,
    `Safety: ${escapeHtml(describeSafety(row))}`,
    `Reserve: ${describeLocalState(row, "reserve")}`,
    `Freeze: ${describeLocalState(row, "freeze")}`,
    "",
    "Tap a row to set a local override. Inherited coverage follows chat/preset policy; membership is not evaluated here.",
  ].join("\n");
}

export function buildCoinKeyboard(
  coinId: string,
  row: SubscriptionRow | null,
  options: { includeMiniAppButton?: boolean; returnPage?: number } = {},
): { inline_keyboard: SettingsButton[][] } {
  const page = options.returnPage ?? 0;
  const dewsBand = row?.alert_dews ? row.dews_min_band ?? "ALERT" : null;
  const depegStep: number | "off" | "default" | null = row?.alert_depeg
    ? row.depeg_worsening_bps_step ?? "default"
    : isExplicitOff(row, "depeg") ? "off" : null;
  const safetyState: boolean | null = row?.alert_safety === 1
    ? true
    : isExplicitOff(row, "safety") ? false : null;
  const plainState = (type: "reserve" | "freeze"): boolean | null =>
    row?.[TELEGRAM_ALERT_PERSISTENCE[type].subscriptionColumn] === 1
      ? true
      : isExplicitOff(row, type) ? false : null;

  const rows: SettingsButton[][] = [
    buildDewsRow(coinId, dewsBand, isExplicitOff(row, "dews"), page),
    buildDepegRow(coinId, depegStep, page),
    buildSafetyRow(coinId, safetyState, page),
    buildPlainAlertRow(coinId, "reserve", plainState("reserve"), page),
    buildPlainAlertRow(coinId, "freeze", plainState("freeze"), page),
    [{ text: "← Back to settings", callback_data: `settings:home:${page}` }],
  ];
  if (options.includeMiniAppButton) {
    rows.push([{ text: "Open in app", web_app: { url: buildTelegramMiniAppUrl(`coin_${coinId}`) } }]);
  }
  return { inline_keyboard: rows };
}

function buildCoinGridRows(
  pageRows: { rows: SubscriptionRow[]; page: number; totalPages: number },
): SettingsButton[][] {
  if (pageRows.rows.length === 0) return [];
  const rows: SettingsButton[][] = [];
  for (let i = 0; i < pageRows.rows.length; i += 2) {
    const pair = pageRows.rows.slice(i, i + 2).map((row) => ({
      text: coinLabel(row.stablecoin_id),
      callback_data: `settings:o:${row.stablecoin_id}:${pageRows.page}`,
    }));
    rows.push(pair);
  }
  if (pageRows.totalPages > 1) {
    const nav: SettingsButton[] = [];
    if (pageRows.page > 0) nav.push({ text: "‹ Prev", callback_data: `settings:home:${pageRows.page - 1}` });
    nav.push({ text: `${pageRows.page + 1}/${pageRows.totalPages}`, callback_data: `settings:home:${pageRows.page}` });
    if (pageRows.page < pageRows.totalPages - 1) nav.push({ text: "Next ›", callback_data: `settings:home:${pageRows.page + 1}` });
    rows.push(nav);
  }
  return rows;
}

function coinLabel(coinId: string): string {
  return TRACKED_META_BY_ID.get(coinId)?.symbol ?? coinId;
}

function presetLabel(presetId: string): string {
  return TELEGRAM_PRESET_LABEL_BY_ID.get(presetId as TelegramPresetId) ?? presetId;
}

function buildDewsRow(
  coinId: string,
  dewsBand: string | null,
  explicitOff: boolean,
  page: number,
): Array<{ text: string; callback_data: string }> {
  const row = TELEGRAM_DEWS_BANDS.map((band, index) => ({
    text: `${index === 0 ? "DEWS: " : ""}${markCompact(dewsBand === band)}${formatDewsCompactBand(band)}`,
    callback_data: `settings:c:${coinId}:db:${DEWS_BAND_CODE_BY_VALUE[band]}:${page}`,
  }));
  row.push({
    text: `${markCompact(explicitOff)}Off`,
    callback_data: `settings:c:${coinId}:db:0:${page}`,
  });
  return row;
}

function buildDepegRow(
  coinId: string,
  depegStep: number | "off" | "default" | null,
  page: number,
): Array<{ text: string; callback_data: string }> {
  const row: Array<{ text: string; callback_data: string }> = [
    {
      text: `Depeg: ${markCompact(depegStep === "default")}Any`,
      callback_data: `settings:c:${coinId}:ds:a:${page}`,
    },
    ...TELEGRAM_DEPEG_STEPS.map((step) => ({
      text: `${markCompact(depegStep === step)}${formatDepegStepPercent(step)}`,
      callback_data: `settings:c:${coinId}:ds:${step}:${page}`,
    })),
    {
      text: `${markCompact(depegStep === "off")}Off`,
      callback_data: `settings:c:${coinId}:ds:0:${page}`,
    },
  ];
  return row;
}

/** D4: simple on/off Safety control (drops the dead direction mode picker). */
function buildSafetyRow(
  coinId: string,
  enabled: boolean | null,
  page: number,
): Array<{ text: string; callback_data: string }> {
  return [
    { text: `Safety: ${markCompact(enabled === true)}on`, callback_data: `settings:c:${coinId}:sm:a:${page}` },
    { text: `${markCompact(enabled === false)}off`, callback_data: `settings:c:${coinId}:sm:0:${page}` },
  ];
}

function buildPlainAlertRow(
  coinId: string,
  alertType: "reserve" | "freeze",
  enabled: boolean | null,
  page: number,
): Array<{ text: string; callback_data: string }> {
  const code = TELEGRAM_ALERT_PERSISTENCE[alertType].settingCode;
  const label = TELEGRAM_ALERT_FAMILY_SHORT_LABELS[alertType];
  return [
    { text: `${label}: ${markCompact(enabled === true)}on`, callback_data: `settings:c:${coinId}:${code}:1:${page}` },
    { text: `${markCompact(enabled === false)}off`, callback_data: `settings:c:${coinId}:${code}:0:${page}` },
  ];
}

function labelForType(type: GlobalAlertType): string {
  return TELEGRAM_ALERT_FAMILY_SHORT_LABELS[type];
}

function markCompact(active: boolean): string {
  return active ? "•" : "";
}

function isExplicitOff(row: SubscriptionRow | null, type: TelegramAlertType): boolean {
  const { subscriptionColumn, overrideColumn } = TELEGRAM_ALERT_PERSISTENCE[type];
  return row?.[subscriptionColumn] === 0 && row[overrideColumn] === 1;
}

function describeLocalState(row: SubscriptionRow | null, type: TelegramAlertType): string {
  if (row?.[TELEGRAM_ALERT_PERSISTENCE[type].subscriptionColumn] === 1) return "on";
  if (isExplicitOff(row, type)) return "off (local override)";
  return (TELEGRAM_PRESET_ALERT_TYPES as readonly TelegramAlertType[]).includes(type)
    ? "inherits chat/preset policy"
    : "inherits chat policy";
}

function describeDews(row: SubscriptionRow | null): string {
  if (!row?.alert_dews) return describeLocalState(row, "dews");
  return formatDewsCompactBand(row.dews_min_band ?? "ALERT");
}

function describeSafety(row: SubscriptionRow | null): string {
  if (!row?.alert_safety) return describeLocalState(row, "safety");
  return row.safety_mode === "upgrade-only" ? "on (upgrades only)" : "on";
}

function describeDepeg(row: SubscriptionRow | null): string {
  if (!row?.alert_depeg) return describeLocalState(row, "depeg");
  return row.depeg_worsening_bps_step != null ? formatDepegStepPercent(row.depeg_worsening_bps_step) : "Any";
}

function formatSavedQuietWindow(subscriber: SubscriberRow | null): string {
  const start = subscriber?.quiet_hours_start_utc ?? DEFAULT_QUIET_START_HOUR;
  const end = subscriber?.quiet_hours_end_utc ?? DEFAULT_QUIET_END_HOUR;
  return formatQuietHours(start, end, subscriber?.timezone);
}

function formatQuietHoursLine(subscriber: SubscriberRow | null): string {
  if (!subscriber?.quiet_hours_enabled) {
    const window = formatSavedQuietWindow(subscriber);
    return `off (${window})`;
  }
  const start = subscriber.quiet_hours_start_utc;
  const end = subscriber.quiet_hours_end_utc;
  if (start == null || end == null) {
    return `off (${formatQuietHours(DEFAULT_QUIET_START_HOUR, DEFAULT_QUIET_END_HOUR, quietHoursTimezoneLabel(subscriber.timezone))})`;
  }
  return formatQuietHours(start, end, subscriber.timezone);
}

function formatAlertsPauseLine(subscriber: SubscriberRow | null): string {
  const until = subscriber?.alert_snooze_until_ts ?? null;
  if (until == null) return "On";
  if (isPausedSentinel(until)) return "Paused (indefinite)";
  const remaining = until - unixNow();
  if (remaining <= 0) return "On";
  return `Paused (${formatSnoozeDuration(remaining)})`;
}
