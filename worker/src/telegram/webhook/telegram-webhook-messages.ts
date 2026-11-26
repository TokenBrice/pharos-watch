import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { formatUsdPriceAdaptive } from "@shared/lib/format";
import { formatRelativeAgeSeconds, formatRelativeDurationSeconds } from "@shared/lib/relative-time";
import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import { isTokenizedFundId } from "@shared/lib/stablecoins/listing-governance";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
  TELEGRAM_PRESET_ALERT_TYPES,
} from "@shared/lib/telegram-alert-families";
import { type TelegramAlertType } from "@shared/types/status";
import { TELEGRAM_LIVE_ALERT_TYPES } from "@shared/types/status/telegram";
import { escapeHtml, type InlineKeyboardButton } from "../delivery/telegram";
import { MANAGE_PAGE_SIZE } from "../common/constants";
import { buildTelegramMiniAppUrl } from "../common/mini-app-url";
import type { ResolvedCoin } from "../common/alerts-parser";
import type { TelegramPresetId } from "../common/presets";
import { isQuietHoursActive } from "../common/quiet-hours";
import { formatTelegramCompactUsd, formatTelegramSignedCompactUsd } from "../common/telegram-format";
import { isSubscribableCoin } from "../store/subscription-eligibility";
import { isGroupChatType } from "./telegram-webhook-auth";
import type { PresetSubscriptionRow, SubscriberRow, SubscriptionRow } from "./telegram-webhook-shared";
import { STABLECOIN_BY_ID } from "./telegram-webhook-shared";
import type { StatusForCoin } from "./telegram-webhook-status";

type AlertFamilySource = SubscriptionRow | PresetSubscriptionRow | SubscriberRow;

interface AlertFamilyDescriptionOptions {
  scope: "subscription" | "global";
  emptyLabel: string;
  labels?: Partial<Record<TelegramAlertType, string>>;
}

const GLOBAL_SAFETY_LABEL = "Safety downgrades of 3+ points";
const LIST_MAX_COINS = 15;

/** Format a slash command for the chat type (addressed with `@Bot` in groups). */
export function cmdForChat(name: string, chatType: string): string {
  const bare = name.startsWith("/") ? name.slice(1) : name;
  return isGroupChatType(chatType) ? `/${bare}@${TELEGRAM_BOT_USERNAME}` : `/${bare}`;
}

export function formatDepegStepPercent(stepBps: number): string {
  return stepBps % 100 === 0 ? `${stepBps / 100}%` : `${(stepBps / 100).toFixed(1)}%`;
}

export function formatDewsCompactBand(band: string): string {
  if (band === "WARNING") return "Warning+";
  if (band === "DANGER") return "Danger only";
  return "Alert+";
}

function formatDepegLabel(step: number | null | undefined): string {
  return step != null ? `Depeg (${formatDepegStepPercent(step)})` : "Depeg";
}

export function buildNotFoundMessage(
  ticker: string,
  suggestion?: ResolvedCoin | string,
  extraInvalidCount = 0,
): string {
  const extraSuffix = extraInvalidCount > 0 ? ` (and ${extraInvalidCount} more)` : "";
  const lines = [`No stablecoin or preset called "${ticker}"${extraSuffix}.`];
  const label = typeof suggestion === "string" ? suggestion : suggestion?.symbol;
  if (label) {
    lines.push(`Did you mean ${label}?`);
  }
  return escapeHtml(lines.join("\n"));
}

export function buildStatusAmbiguousMessage(
  ticker: string,
  candidates: ResolvedCoin[],
  commandName = "/status",
): string {
  return escapeHtml(
    [
      `"${ticker}" matches ${candidates.length} coins:`,
      ...candidates.map((coin) => `- ${coin.symbol} — ${coin.name} (${coin.id})`),
      "",
      `Re-run ${commandName} with the exact Pharos coin id, e.g.:`,
      `${commandName} ${candidates[0]?.id ?? "<coin-id>"}`,
    ].join("\n"),
  );
}

interface SubscriptionSummaryOptions {
  introLines?: string[];
  maxRows?: number;
  footerLine?: string;
}

interface UnsubscribeSummaryOptions {
  maxRows?: number;
  footerLine?: string;
}

export function sortSubscriptions(subscriptions: SubscriptionRow[]): SubscriptionRow[] {
  return [...subscriptions].sort((a, b) => {
    const aCoin = STABLECOIN_BY_ID.get(a.stablecoin_id);
    const bCoin = STABLECOIN_BY_ID.get(b.stablecoin_id);
    const aSymbol = aCoin?.symbol ?? a.stablecoin_id;
    const bSymbol = bCoin?.symbol ?? b.stablecoin_id;
    return aSymbol.localeCompare(bSymbol) || a.stablecoin_id.localeCompare(b.stablecoin_id);
  });
}

export function paginateChatRows<T>(
  rows: readonly T[],
  requestedPage: number,
  pageSize = MANAGE_PAGE_SIZE,
): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const start = page * pageSize;
  return { rows: rows.slice(start, start + pageSize), page, totalPages };
}

function describeAlertFamilies(
  source: AlertFamilySource | null,
  options: AlertFamilyDescriptionOptions,
): string {
  if (!source) return options.emptyLabel;
  const values = source as unknown as Record<string, unknown>;
  // Launch is retired: a leftover launch column no longer reads as a follow.
  const labels = TELEGRAM_LIVE_ALERT_TYPES.flatMap((alertType) => {
    const persistence = TELEGRAM_ALERT_PERSISTENCE[alertType];
    const column = options.scope === "global" ? persistence.globalColumn : persistence.subscriptionColumn;
    return values[column]
      ? [options.labels?.[alertType] ?? TELEGRAM_ALERT_FAMILY_SHORT_LABELS[alertType]]
      : [];
  });
  return labels.join(", ") || options.emptyLabel;
}

function formatCoinLabel(stablecoinId: string): string {
  return STABLECOIN_BY_ID.get(stablecoinId)?.symbol ?? stablecoinId;
}

function formatPresetLabelList(
  presetIds: readonly TelegramPresetId[],
  presetLabelById: ReadonlyMap<string, string>,
): string {
  return presetIds.map((presetId) => presetLabelById.get(presetId) ?? presetId).join(", ");
}

function appendTruncationLine(lines: string[], totalCount: number, shownCount: number, footerLine?: string): void {
  if (shownCount < totalCount) {
    lines.push(`...and ${totalCount - shownCount} more.`);
  }
  if (footerLine) {
    lines.push(footerLine);
  }
}

export function buildUnsubscribeSuccessMessage(coins: ResolvedCoin[], options: UnsubscribeSummaryOptions = {}): string {
  const sortedCoins = [...coins].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
  const maxRows = options.maxRows ?? sortedCoins.length;
  const shownCoins = sortedCoins.slice(0, maxRows);
  const lines = [
    `Removed ${coins.length} coin subscription${coins.length === 1 ? "" : "s"}.`,
    "Coins:",
    formatCoinLines(shownCoins),
  ];
  appendTruncationLine(lines, sortedCoins.length, shownCoins.length, options.footerLine);
  return escapeHtml(lines.join("\n"));
}

/** A coin with no direct row is not removed; a preset or global follow may still cover it. */
export function buildUnsubscribeNoopMessage(coins: ResolvedCoin[], chatType = "private"): string {
  const symbols = [...new Set(coins.map((coin) => coin.symbol))].sort((a, b) => a.localeCompare(b));
  const lines = symbols.length > 0
    ? [`Not followed directly: ${symbols.join(", ")}.`, "Nothing was removed."]
    : ["Nothing was removed."];
  const turnOffHint = chatType === "private"
    ? "Preset and all-stablecoin follows are unchanged. To turn off alerts for a coin covered by a preset, switch its families off in Manage Alerts."
    : `Preset and all-stablecoin follows are unchanged. To turn off alerts for a coin covered by a preset, switch its families off in ${cmdForChat("settings", chatType)}.`;
  lines.push(turnOffHint, `See ${cmdForChat("list", chatType)} for what you follow.`);
  return escapeHtml(lines.join("\n"));
}

/** Contextual button when `/unsubscribe` (or `pick:un`) was a no-op for one subscribable coin. */
export function buildUnsubscribeNoopKeyboard(
  coins: readonly ResolvedCoin[],
  chatType: string,
): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (coins.length !== 1) return undefined;
  const coin = coins[0]!;
  if (!isSubscribableCoin(coin.id)) return undefined;
  if (chatType === "private") {
    return buildMiniAppOnlyKeyboard(`Manage ${coin.symbol}`, formatCoinPayload(coin.id));
  }
  const settingsData = `settings:o:${coin.id}`;
  return fitsCallbackData(settingsData)
    ? { inline_keyboard: [[{ text: `${coin.symbol} settings`, callback_data: settingsData }]] }
    : undefined;
}

export function buildSubscriptionSummaryMessage(
  header: string,
  subscriptions: SubscriptionRow[],
  options: SubscriptionSummaryOptions = {},
): string {
  const sorted = sortSubscriptions(subscriptions);
  const maxRows = options.maxRows ?? sorted.length;
  const shown = sorted.slice(0, maxRows);
  const lines = [...(options.introLines ?? []), header, `Coins (${subscriptions.length}):`];
  for (const row of shown) {
    lines.push(`- ${formatCoinLabel(row.stablecoin_id)}: ${describeSubscriptionSettings(row)}`);
  }
  appendTruncationLine(lines, sorted.length, shown.length, options.footerLine);
  return escapeHtml(lines.join("\n"));
}

export interface ListMessageInput {
  subscriber: SubscriberRow | null;
  subscriptions: SubscriptionRow[];
  presetSubscriptions: PresetSubscriptionRow[];
  presetLabelById: ReadonlyMap<string, string>;
  lastDeliveryAt?: number | null;
  nowSec?: number;
  chatType?: string;
  maxCoins?: number;
}

export function hasActiveFamily(row: SubscriptionRow): boolean {
  return describeAlertFamilies(row, { scope: "subscription", emptyLabel: "" }) !== "";
}

/** Only every live family explicitly marked off suppresses inheritance. */
function hasOnlyMarkedOffFamilies(row: SubscriptionRow): boolean {
  return TELEGRAM_LIVE_ALERT_TYPES.every((family) => {
    const columns = TELEGRAM_ALERT_PERSISTENCE[family];
    return row[columns.overrideColumn] === 1 && row[columns.subscriptionColumn] !== 1;
  });
}

/** True when the chat follows nothing: no preset, no active coin, no global family. */
export function followsNothing(input: Pick<ListMessageInput, "subscriber" | "subscriptions" | "presetSubscriptions">): boolean {
  const activePreset = input.presetSubscriptions.some((row) =>
    TELEGRAM_PRESET_ALERT_TYPES.some((type) => row[TELEGRAM_ALERT_PERSISTENCE[type].subscriptionColumn]));
  return !input.subscriptions.some(hasActiveFamily) && !activePreset && describeGlobalAlertSettings(input.subscriber) === "None";
}

/** One-line-per-coin follow breakdown used by `/list`, `/settings`, and returning `/start`. */
export function describeFollows(input: ListMessageInput): string[] {
  const lines: string[] = [];
  const chatType = input.chatType ?? "private";
  const maxCoins = input.maxCoins ?? LIST_MAX_COINS;
  for (const row of input.presetSubscriptions) {
    const label = input.presetLabelById.get(row.preset_id) ?? row.preset_id;
    lines.push(`<b>${escapeHtml(label)}</b> (preset, updates with market cap): ${escapeHtml(describePresetSubscriptionSettings(row))}`);
  }
  const sorted = sortSubscriptions(input.subscriptions);
  // Bucket by the override markers, not raw enablement: an unmarked zero
  // inherits preset/global routing and must not be reported as off.
  const followed = sorted.filter((row) => !hasOnlyMarkedOffFamilies(row));
  const allOff = sorted.filter(hasOnlyMarkedOffFamilies);
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (followed.length > 0) {
    const shown = followed.slice(0, maxCoins);
    lines.push(`<b>Coins (${followed.length}):</b>`);
    for (const row of shown) {
      lines.push(`• ${escapeHtml(formatCoinLabel(row.stablecoin_id))} — ${escapeHtml(describeSubscriptionSettings(row, nowSec))}`);
    }
    const remaining = followed.length - shown.length;
    if (remaining > 0) {
      lines.push(
        chatType === "private"
          ? `…and ${remaining} more in ${MANAGE_ALERTS_LABEL}.`
          : `…and ${remaining} more. Use ${escapeHtml(cmdForChat("settings", chatType))} to browse.`,
      );
    }
  }
  if (allOff.length > 0) {
    lines.push(`<b>Alerts off:</b> ${escapeHtml(allOff.map((row) => formatCoinLabel(row.stablecoin_id)).join(", "))}`);
  }
  const global = describeGlobalAlertSettings(input.subscriber);
  if (global !== "None") lines.push(`<b>All stablecoins:</b> ${escapeHtml(global)}`);
  return lines;
}

/** Compact one-line coverage summary for the bare `/status` health + risk card. */
export function describeFollowsCompact(input: ListMessageInput): string[] {
  const parts: string[] = [];
  if (input.presetSubscriptions.length > 0) {
    const presetLabels = input.presetSubscriptions.map(
      (row) => input.presetLabelById.get(row.preset_id) ?? row.preset_id,
    );
    parts.push(presetLabels.length <= 2 ? presetLabels.join(", ") : `${presetLabels.length} presets`);
  }
  const sorted = sortSubscriptions(input.subscriptions);
  const activeDirect = sorted.filter(hasActiveFamily);
  const allOff = sorted.filter(hasOnlyMarkedOffFamilies);
  if (activeDirect.length > 0) {
    const symbols = activeDirect.map((row) => formatCoinLabel(row.stablecoin_id));
    parts.push(
      symbols.length <= 3
        ? symbols.join(", ")
        : `${symbols.length} coins`,
    );
  }
  if (describeGlobalAlertSettings(input.subscriber) !== "None") {
    parts.push("All stablecoins");
  }
  if (allOff.length > 0) {
    parts.push(`${allOff.length} off`);
  }
  return parts.length > 0 ? [`<b>Following:</b> ${escapeHtml(parts.join(" · "))}`] : [];
}

/** Pause and quiet-hours state as user-facing lines; empty when neither applies. */
export function describeDeliveryState(
  subscriber: SubscriberRow | null,
  nowSec: number,
  chatType = "private",
): string[] {
  const lines: string[] = [];
  const snoozeUntil = subscriber?.alert_snooze_until_ts ?? null;
  if (snoozeUntil != null && snoozeUntil > nowSec) {
    lines.push(isPausedSentinel(snoozeUntil)
      ? `Alerts are paused until you resume (${escapeHtml(cmdForChat("pause", chatType))} off).`
      : `Alerts are paused for ${formatSnoozeDuration(snoozeUntil - nowSec)} more.`);
  }
  if (subscriber?.quiet_hours_enabled) {
    lines.push(`Quiet hours ${escapeHtml(formatQuietHoursStatus(subscriber, nowSec))}`);
  }
  return lines;
}

export function buildListMessage(input: ListMessageInput): string {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const chatType = input.chatType ?? "private";
  const lines = [
    "<b>What you follow</b>",
    ...describeFollows({ ...input, nowSec, chatType }),
    ...describeDeliveryState(input.subscriber, nowSec, chatType),
  ];
  if (input.lastDeliveryAt != null) {
    lines.push(`Last alert delivered ${escapeHtml(formatElapsed(input.lastDeliveryAt, nowSec))}.`);
  }
  return lines.join("\n");
}

export function buildPresetUnavailableMessage(): string {
  return escapeHtml(
    "Preset watchlists are temporarily unavailable because the stablecoin cache could not be loaded. Try again in a few minutes.",
  );
}

export function buildPresetSubscriptionSummaryMessage(
  subscriptions: SubscriptionRow[],
  options: {
    presetIds: readonly TelegramPresetId[];
    presetLabelById: ReadonlyMap<string, string>;
    presetCoinCount: number;
    chatType?: string;
  },
): string {
  const sorted = sortSubscriptions(subscriptions);
  const count = options.presetCoinCount;
  const chatType = options.chatType ?? "private";
  const lines = [
    `Done. You follow ${formatPresetLabelList(options.presetIds, options.presetLabelById)} (${count} coin${count === 1 ? "" : "s"} today; the list updates with market cap).`,
  ];
  if (sorted.length > 0) {
    lines.push(`Also updated: ${sorted.map((row) => `${formatCoinLabel(row.stablecoin_id)} (${describeSubscriptionSettings(row)})`).join(", ")}`);
  }
  lines.push(`See everything with ${cmdForChat("list", chatType)}.`);
  return escapeHtml(lines.join("\n"));
}

export function buildPresetUnsubscribeSummaryMessage(
  coins: ResolvedCoin[],
  options: {
    presetIds: readonly TelegramPresetId[];
    presetLabelById: ReadonlyMap<string, string>;
    chatType?: string;
  },
): string {
  const chatType = options.chatType ?? "private";
  const lines = [
    `Stopped following ${formatPresetLabelList(options.presetIds, options.presetLabelById)}. Coins you follow directly are unchanged.`,
  ];
  if (coins.length > 0) {
    const sortedCoins = [...coins].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
    const shownCoins = sortedCoins.slice(0, 12);
    lines.push(`Also removed (${coins.length}):`, formatCoinLines(shownCoins));
    appendTruncationLine(lines, sortedCoins.length, shownCoins.length);
  }
  lines.push(`See what is left with ${cmdForChat("list", chatType)}.`);
  return escapeHtml(lines.join("\n"));
}

export function describeSubscriptionSettings(
  row: SubscriptionRow,
  nowSec: number = Math.floor(Date.now() / 1000),
  options: { perCoinTag?: boolean } = {},
): string {
  const description = describeAlertFamilies(row, {
    scope: "subscription",
    emptyLabel: "",
    labels: {
      dews: row.dews_min_band && row.dews_min_band !== "ALERT"
        ? `DEWS (${formatDewsCompactBand(row.dews_min_band)})`
        : "DEWS",
      depeg: formatDepegLabel(row.depeg_worsening_bps_step),
      safety: row.safety_mode === "upgrade-only" ? "Safety (upgrades only)" : "Safety",
    },
  });
  const suppressed = TELEGRAM_LIVE_ALERT_TYPES.filter((family) => {
    const columns = TELEGRAM_ALERT_PERSISTENCE[family];
    return row[columns.overrideColumn] === 1 && row[columns.subscriptionColumn] !== 1;
  });
  const fullyOff = suppressed.length === TELEGRAM_LIVE_ALERT_TYPES.length;
  let base = fullyOff
    ? "All alerts off"
    : description
      ? options.perCoinTag ? `${description} · custom` : description
      : "via preset";
  if (suppressed.length > 0 && !fullyOff) {
    base += ` · ${suppressed.map((family) => TELEGRAM_ALERT_FAMILY_SHORT_LABELS[family]).join(", ")} off`;
  }

  // Per-coin snooze countdown (P1-U10): shown alongside the alert list so
  // /list surfaces an active per-coin snooze without forcing the user to
  // open the settings keyboard.
  const snoozeUntil = row.alert_snooze_until_ts;
  if (snoozeUntil != null && snoozeUntil > nowSec) {
    return `${base} · snoozed ${formatSnoozeDuration(snoozeUntil - nowSec)}`;
  }
  return base;
}

export function describePresetSubscriptionSettings(row: PresetSubscriptionRow): string {
  return describeAlertFamilies(row, {
    scope: "subscription",
    emptyLabel: "Off",
    labels: { depeg: formatDepegLabel(row.depeg_worsening_bps_step) },
  });
}

export function describeGlobalAlertSettings(subscriber: SubscriberRow | null): string {
  return describeAlertFamilies(subscriber, {
    scope: "global",
    emptyLabel: "None",
    labels: {
      depeg: formatDepegLabel(subscriber?.global_depeg_worsening_bps_step),
      safety: GLOBAL_SAFETY_LABEL,
    },
  });
}

function formatCoinLines(coins: ResolvedCoin[]): string {
  return coins.map((coin) => `- ${coin.symbol}`).join("\n") || "None";
}

export function quietHoursTimezoneLabel(timezone: string | null | undefined): string {
  return timezone?.trim() || "UTC";
}

export function formatQuietHours(
  startHourUtc: number | null | undefined,
  endHourUtc: number | null | undefined,
  timezone: string | null | undefined = null,
): string {
  if (startHourUtc == null || endHourUtc == null) return "Off";
  const pad = (h: number) => String(h).padStart(2, "0");
  return `${pad(startHourUtc)}:00-${pad(endHourUtc)}:00 ${quietHoursTimezoneLabel(timezone)}`;
}

function formatQuietHoursStatus(subscriber: SubscriberRow | null, nowSec: number): string {
  if (!subscriber?.quiet_hours_enabled) return "Off";
  const start = subscriber.quiet_hours_start_utc;
  const end = subscriber.quiet_hours_end_utc;
  if (start == null || end == null) return "Off";
  const pad = (h: number) => String(h).padStart(2, "0");
  const zone = quietHoursTimezoneLabel(subscriber.timezone);
  if (isQuietHoursActive(nowSec, true, start, end, subscriber.timezone ?? null)) {
    return `active until ${pad(end)}:00 ${zone}`;
  }
  return `${pad(start)}:00-${pad(end)}:00 ${zone}`;
}

export function formatSnoozeDuration(seconds: number): string {
  return formatRelativeDurationSeconds(seconds, {
    nowLabel: "less than 1 min",
    unitStyle: "short",
    rounding: "round",
    dayThresholdSec: 48 * 3600,
  });
}

export function formatElapsed(ts: number | null | undefined, nowSec = Math.floor(Date.now() / 1000)): string {
  if (ts == null || !Number.isFinite(ts)) return "";
  const ageSec = Math.max(0, nowSec - ts);
  return formatRelativeAgeSeconds(ageSec, {
    suffix: "ago",
    nowLabel: "just now",
    nowThresholdSec: 90,
    rounding: "round",
    dayThresholdSec: 172800,
  });
}

const CALLBACK_DATA_MAX_BYTES = 64;

export function fitsCallbackData(data: string): boolean {
  return new TextEncoder().encode(data).length <= CALLBACK_DATA_MAX_BYTES;
}

/** The single Mini App entry label used everywhere in chat. */
export const MANAGE_ALERTS_LABEL = "Manage Alerts";

export function buildManageAlertsKeyboard(payload = "watchlist"): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  return buildMiniAppOnlyKeyboard(MANAGE_ALERTS_LABEL, payload);
}

export function buildMiniAppOnlyKeyboard(
  text = MANAGE_ALERTS_LABEL,
  payload = "watchlist",
): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  return { inline_keyboard: [[{ text, web_app: { url: buildTelegramMiniAppUrl(payload) } }]] };
}

/**
 * `/status <coin>` keyboard:
 * - Omitted entirely for non-subscribable (delisted/frozen/etc.) coins.
 * - Omits `[Follow {SYM}]` when already directly followed.
 * - Private chats attach `[Manage {SYM}]` (`coin_<id>`).
 * - Group chats attach `[{SYM} settings]` (`settings:o:<id>`).
 */
export function buildCoinStatusKeyboard(
  stablecoinId: string,
  symbol: string,
  options: { includeMiniAppButton?: boolean; isGroup?: boolean; alreadyFollowed?: boolean } = {},
): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (!isSubscribableCoin(stablecoinId)) return undefined;
  const row: InlineKeyboardButton[] = [];
  if (!options.alreadyFollowed) {
    const followData = `quicksub:${stablecoinId}`;
    if (fitsCallbackData(followData)) row.push({ text: `Follow ${symbol}`, callback_data: followData });
  }
  if (options.includeMiniAppButton) {
    row.push({ text: `Manage ${symbol}`, web_app: { url: buildTelegramMiniAppUrl(formatCoinPayload(stablecoinId)) } });
  } else if (options.isGroup) {
    const settingsData = `settings:o:${stablecoinId}`;
    if (fitsCallbackData(settingsData)) row.push({ text: `${symbol} settings`, callback_data: settingsData });
  }
  return row.length > 0 ? { inline_keyboard: [row] } : undefined;
}

/** Safety grade in plain words; model, version and generation ids stay on the website. */
export function formatTelegramSafety(safety: NonNullable<StatusForCoin["safety"]>): string {
  const rating = safety.ratingStatus === "pipeline-gap"
    ? "not available right now"
    : safety.grade ?? (safety.ratingStatus === "not-rated" ? "Unrated" : "Unavailable");
  return `${rating}${safety.score != null ? ` (${safety.score})` : ""}${safety.ratingStatus !== "pipeline-gap" && safety.partialEvidence ? ", some inputs missing" : ""}`;
}

function formatUpdated(ts: number | null | undefined, nowSec: number): string {
  return ts == null || !Number.isFinite(ts) ? "update time unknown" : `updated ${formatElapsed(ts, nowSec)}`;
}

function formatYieldLine(status: StatusForCoin, nowSec: number): string | null {
  const value = status.yield;
  if (!value) {
    // Coins with no yield have no line; a failed yield read says so.
    const notYieldBearing = status.yieldUnavailableReason == null || status.yieldUnavailableReason === "yield-ranking-not-found";
    return notYieldBearing ? null : "<b>Yield:</b> not available right now";
  }
  return `<b>Yield:</b> ${value.apy30d.toFixed(2)}% (30-day, ${escapeHtml(value.source)}), ${formatUpdated(value.provenance?.sourceObservedAt, nowSec)}`;
}

function formatActiveDepeg(depeg: Extract<StatusForCoin["depeg"], { status: "active" }>): string {
  const percent = `${(Math.abs(depeg.peakDeviationBps) / 100).toFixed(1)}%`;
  const opening = depeg.peerOpening ? `opened ${depeg.direction} the peer median (lower confidence)` : `off peg (${depeg.direction})`;
  if (depeg.peakBasisUnavailable) return `${opening}, peak comparison unavailable`;
  if (depeg.peerRelative) {
    return `${depeg.peerOpening ? "peer-relative incident" : opening}, peak ${percent} ${depeg.direction} the peer median (lower confidence)`;
  }
  return `${opening}, peak ${percent}${depeg.peerOpening ? ` ${depeg.direction} peg` : ""}`;
}

function formatCoinStatusHeader(symbol: string, stablecoinId: string): string {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const boldSymbol = `<b>${escapeHtml(symbol)}</b>`;
  const distinctName = meta?.name && meta.name.toLowerCase() !== symbol.toLowerCase()
    ? ` — ${escapeHtml(meta.name)}`
    : "";
  const pegTag = meta?.pegCurrency && meta.pegCurrency !== "USD"
    ? ` (${escapeHtml(meta.pegCurrency)} peg)`
    : "";
  return `${boldSymbol}${distinctName}${pegTag}`;
}

/**
 * `/status <coin>` card. Every value names how old it is and an unavailable
 * value says so instead of disappearing. No freshness verdict is published
 * here; budgets and generations stay on the website and API.
 */
export function buildStatusMessage(symbol: string, s: StatusForCoin, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = formatCoinStatusHeader(symbol, s.stablecoinId);
  const price = s.priceUsd != null ? `$${formatUsdPriceAdaptive(s.priceUsd)}` : null;
  const headline = s.depeg.status === "active"
    ? `${s.depeg.direction === "below" ? "▼" : "▲"} ${header}\n${formatActiveDepeg(s.depeg)}, since ${formatElapsed(s.depeg.startedAt, nowSec)}${price ? ` · <b>Price:</b> ${price}` : ""}`
    : `${header}\n<b>Price:</b> ${price ?? "no recent price"} · No active depeg`;
  const isTokenizedFund = isTokenizedFundId(s.stablecoinId);
  const safety = isTokenizedFund && s.safety?.ratingStatus !== "pipeline-gap"
    ? "<b>Safety:</b> Tokenized fund (not graded)"
    : s.safety
      ? `<b>Safety:</b> ${formatTelegramSafety(s.safety)}`
      : s.safetyUnavailableReason
        ? "<b>Safety:</b> not available right now"
        : "<b>Safety:</b> Not rated";
  const dews = s.dews
    ? `<b>Early warning (DEWS):</b> ${s.dews.band} (${s.dews.score}/100)`
    : "<b>Early warning (DEWS):</b> not available right now";
  const supply = formatTelegramCompactUsd(s.supplyUsd);
  const flow = s.flow ? formatTelegramSignedCompactUsd(s.flow.netFlowUsd) : null;
  const supplyLine = [
    supply ? `<b>Supply:</b> ${supply}, ${formatUpdated(s.supplyObservedAt, nowSec)}` : "<b>Supply:</b> not available right now",
    flow && s.flow ? `<b>24h flow:</b> ${flow} (${formatUpdated(s.flow.updatedAt, nowSec)})` : null,
  ].filter(Boolean).join(" · ");
  const liquidityTvl = formatTelegramCompactUsd(s.liquidity?.totalTvlUsd);
  const liquidityLine = s.liquidity
    ? `<b>DEX liquidity:</b> ${liquidityTvl ?? "not available"}${s.liquidity.score != null ? ` (score ${s.liquidity.score}/100)` : ""}, ${formatUpdated(s.liquidity.updatedAt, nowSec)}`
    : s.liquidityUnavailableReason
      ? "<b>DEX liquidity:</b> not available right now"
      : null;
  const clocks = [
    s.priceUpdatedAt != null ? `price ${formatUpdated(s.priceUpdatedAt, nowSec)}` : null,
    s.safety && !isTokenizedFund ? `Safety ${formatUpdated(s.safety.publishedAt, nowSec)}` : null,
    s.dews ? `DEWS ${formatUpdated(s.dews.computedAt, nowSec)}` : null,
  ].filter((part): part is string => part != null);
  const lines = [
    headline,
    safety,
    dews,
    supplyLine,
    liquidityLine,
    formatYieldLine(s, nowSec),
    clocks.length > 0 ? `<i>${clocks.join(" · ")}</i>` : null,
    `<a href="https://pharos.watch/stablecoin/${encodeURIComponent(s.stablecoinId)}">Full report on Pharos</a>`,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
