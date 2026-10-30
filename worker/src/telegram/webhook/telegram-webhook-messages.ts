import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { formatRelativeAgeSeconds, formatRelativeDurationSeconds } from "@shared/lib/relative-time";
import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
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

function formatDepegLabel(step: number | null | undefined): string {
  return step != null ? `Depeg +${step}bps` : "Depeg";
}

export function buildNotFoundMessage(ticker: string, suggestion?: ResolvedCoin): string {
  const lines = [`No stablecoin or preset called "${ticker}".`];
  if (suggestion) {
    lines.push(`Did you mean ${suggestion.symbol}?`);
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
): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const start = page * MANAGE_PAGE_SIZE;
  return { rows: rows.slice(start, start + MANAGE_PAGE_SIZE), page, totalPages };
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

/** A coin with no direct row is not removed; a preset may still cover it. */
export function buildUnsubscribeNoopMessage(coins: ResolvedCoin[]): string {
  const symbols = [...new Set(coins.map((coin) => coin.symbol))].sort((a, b) => a.localeCompare(b));
  const lines = symbols.length > 0
    ? [`Not followed directly: ${symbols.join(", ")}.`, "Nothing was removed."]
    : ["Nothing was removed."];
  lines.push("Preset follows are unchanged. See /list for this chat's direct follows.");
  return escapeHtml(lines.join("\n"));
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
}

function hasActiveFamily(row: SubscriptionRow): boolean {
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
  const activePreset = input.presetSubscriptions.some((row) => row.alert_dews || row.alert_depeg || row.alert_safety);
  return !input.subscriptions.some(hasActiveFamily) && !activePreset && describeGlobalAlertSettings(input.subscriber) === "None";
}

/** One line per follow source, in the order a user thinks about them. */
export function describeFollows(input: ListMessageInput): string[] {
  const lines: string[] = [];
  for (const row of input.presetSubscriptions) {
    const label = input.presetLabelById.get(row.preset_id) ?? row.preset_id;
    lines.push(`<b>${escapeHtml(label)}</b> (preset, updates with market cap): ${escapeHtml(describePresetSubscriptionSettings(row))}`);
  }
  const sorted = sortSubscriptions(input.subscriptions);
  // Bucket by the override markers, not raw enablement: an unmarked zero
  // inherits preset/global routing and must not be reported as muted.
  const followed = sorted.filter((row) => !hasOnlyMarkedOffFamilies(row));
  const muted = sorted.filter(hasOnlyMarkedOffFamilies);
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (followed.length > 0) {
    const coins = followed.map((row) => `${formatCoinLabel(row.stablecoin_id)} (${describeSubscriptionSettings(row, nowSec)})`);
    lines.push(`<b>Coins:</b> ${escapeHtml(coins.join(", "))}`);
  }
  if (muted.length > 0) {
    lines.push(`<b>Muted:</b> ${escapeHtml(muted.map((row) => formatCoinLabel(row.stablecoin_id)).join(", "))}`);
  }
  const global = describeGlobalAlertSettings(input.subscriber);
  if (global !== "None") lines.push(`<b>Every tracked coin:</b> ${escapeHtml(global)}`);
  return lines;
}

/** Pause and quiet-hours state as user-facing lines; empty when neither applies. */
export function describeDeliveryState(subscriber: SubscriberRow | null, nowSec: number): string[] {
  const lines: string[] = [];
  const snoozeUntil = subscriber?.alert_snooze_until_ts ?? null;
  if (snoozeUntil != null && snoozeUntil > nowSec) {
    lines.push(isPausedSentinel(snoozeUntil)
      ? "Alerts are paused until you resume (/pause off)."
      : `Alerts are paused for ${formatSnoozeDuration(snoozeUntil - nowSec)} more.`);
  }
  if (subscriber?.quiet_hours_enabled) {
    lines.push(`Quiet hours ${escapeHtml(formatQuietHoursStatus(subscriber, nowSec))}`);
  }
  return lines;
}

export function buildListMessage(input: ListMessageInput): string {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const lines = [
    "<b>What you follow</b>",
    ...describeFollows({ ...input, nowSec }),
    ...describeDeliveryState(input.subscriber, nowSec),
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
  },
): string {
  const sorted = sortSubscriptions(subscriptions);
  const count = options.presetCoinCount;
  const lines = [
    `Done. You follow ${formatPresetLabelList(options.presetIds, options.presetLabelById)} (${count} coin${count === 1 ? "" : "s"} today; the list updates with market cap).`,
  ];
  if (sorted.length > 0) {
    lines.push(`Also updated: ${sorted.map((row) => `${formatCoinLabel(row.stablecoin_id)} (${describeSubscriptionSettings(row)})`).join(", ")}`);
  }
  lines.push("See everything with /list.");
  return escapeHtml(lines.join("\n"));
}

export function buildPresetUnsubscribeSummaryMessage(
  coins: ResolvedCoin[],
  options: {
    presetIds: readonly TelegramPresetId[];
    presetLabelById: ReadonlyMap<string, string>;
  },
): string {
  const lines = [
    `Stopped following ${formatPresetLabelList(options.presetIds, options.presetLabelById)}. Coins you follow directly are unchanged.`,
  ];
  if (coins.length > 0) {
    const sortedCoins = [...coins].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
    const shownCoins = sortedCoins.slice(0, 12);
    lines.push(`Also removed (${coins.length}):`, formatCoinLines(shownCoins));
    appendTruncationLine(lines, sortedCoins.length, shownCoins.length);
  }
  lines.push("See what is left with /list.");
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
      dews: row.dews_min_band ? `DEWS>=${row.dews_min_band}` : "DEWS",
      depeg: formatDepegLabel(row.depeg_worsening_bps_step),
      safety: row.safety_mode === "downgrade-only"
        ? "Safety downgrade-only"
        : row.safety_mode === "upgrade-only"
          ? "Safety upgrade-only"
          : "Safety",
    },
  });
  const suppressed = TELEGRAM_LIVE_ALERT_TYPES.filter((family) => {
    const columns = TELEGRAM_ALERT_PERSISTENCE[family];
    return row[columns.overrideColumn] === 1 && row[columns.subscriptionColumn] !== 1;
  });
  const fullyMuted = suppressed.length === TELEGRAM_LIVE_ALERT_TYPES.length;
  let base = fullyMuted
    ? options.perCoinTag ? "Muted (overrides defaults)" : "Muted"
    : description
      ? options.perCoinTag ? `${description} · per-coin` : description
      : "Inherits preset/global defaults";
  if (suppressed.length > 0 && !fullyMuted) {
    base += `; off: ${suppressed.map((family) => TELEGRAM_ALERT_FAMILY_SHORT_LABELS[family]).join(", ")} (overrides defaults)`;
  }

  // Per-coin snooze countdown (P1-U10): shown alongside the alert list so
  // /list surfaces an active per-coin snooze without forcing the user to
  // open the settings keyboard.
  const snoozeUntil = row.alert_snooze_until_ts;
  if (snoozeUntil != null && snoozeUntil > nowSec) {
    return `${base} — snoozed for ${formatSnoozeDuration(snoozeUntil - nowSec)}`;
  }
  return base;
}

function describePresetSubscriptionSettings(row: PresetSubscriptionRow): string {
  return describeAlertFamilies(row, {
    scope: "subscription",
    emptyLabel: "Muted",
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

function quietHoursTimezoneLabel(timezone: string | null | undefined): string {
  return timezone?.trim() || "UTC";
}

export function formatQuietHours(
  startHourUtc: number | null | undefined,
  endHourUtc: number | null | undefined,
  timezone: string | null | undefined = null,
): string {
  if (startHourUtc == null || endHourUtc == null) return "Off";
  const pad = (h: number) => String(h).padStart(2, "0");
  return `${pad(startHourUtc)}:00–${pad(endHourUtc)}:00 ${quietHoursTimezoneLabel(timezone)}`;
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
  return `${pad(start)}:00–${pad(end)}:00 ${zone}`;
}


function formatSnoozeDuration(seconds: number): string {
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

/** `/status <coin>` keyboard: follow the coin, plus its Mini App page in private chats. */
export function buildCoinStatusKeyboard(
  stablecoinId: string,
  symbol: string,
  options: { includeMiniAppButton?: boolean } = {},
): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  const row: InlineKeyboardButton[] = [];
  const followData = `quicksub:${stablecoinId}`;
  if (fitsCallbackData(followData)) row.push({ text: `Follow ${symbol}`, callback_data: followData });
  if (options.includeMiniAppButton) {
    row.push({ text: `Manage ${symbol}`, web_app: { url: buildTelegramMiniAppUrl(formatCoinPayload(stablecoinId)) } });
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
    return notYieldBearing ? null : "Yield not available right now";
  }
  return `Yield ${value.apy30d.toFixed(2)}% (30-day, ${escapeHtml(value.source)}), ${formatUpdated(value.provenance?.sourceObservedAt, nowSec)}`;
}

/**
 * `/status <coin>` card. Every value names how old it is and an unavailable
 * value says so instead of disappearing. No freshness verdict is published
 * here; budgets and generations stay on the website and API.
 */
export function buildStatusMessage(symbol: string, s: StatusForCoin, nowSec = Math.floor(Date.now() / 1000)): string {
  const name = `<b>${escapeHtml(symbol)}</b>`;
  const price = s.priceUsd != null ? `$${s.priceUsd.toFixed(4)}` : null;
  const headline = s.depeg.status === "active"
    ? `${s.depeg.direction === "below" ? "▼" : "▲"} ${name} off peg (${s.depeg.direction}), peak ${(Math.abs(s.depeg.peakDeviationBps) / 100).toFixed(1)}%, since ${formatElapsed(s.depeg.startedAt, nowSec)}${price ? `. Price ${price}` : ""}`
    : price
      ? `${name} at ${price}, no active depeg`
      : `${name}: no recent price, no active depeg`;
  const safety = s.safety
    ? `Safety grade ${formatTelegramSafety(s.safety)}`
    : s.safetyUnavailableReason
      ? "Safety grade not available right now"
      : "Not rated for safety";
  const dews = s.dews
    ? `early-warning stress ${s.dews.band} (${s.dews.score}/100)`
    : "early-warning stress not available right now";
  const supply = formatTelegramCompactUsd(s.supplyUsd);
  const flow = s.flow ? formatTelegramSignedCompactUsd(s.flow.netFlowUsd) : null;
  const supplyLine = [
    supply ? `Supply ${supply}, ${formatUpdated(s.supplyObservedAt, nowSec)}` : "Supply not available right now",
    flow && s.flow ? `24h net flow ${flow} (${formatUpdated(s.flow.updatedAt, nowSec)})` : null,
  ].filter(Boolean).join(" · ");
  const liquidityTvl = formatTelegramCompactUsd(s.liquidity?.totalTvlUsd);
  const liquidityLine = s.liquidity
    ? `DEX liquidity ${liquidityTvl ?? "not available"}${s.liquidity.score != null ? ` (score ${s.liquidity.score}/100)` : ""}, ${formatUpdated(s.liquidity.updatedAt, nowSec)}`
    : s.liquidityUnavailableReason
      ? "DEX liquidity not available right now"
      : null;
  const clocks = [
    s.priceUpdatedAt != null ? `price ${formatUpdated(s.priceUpdatedAt, nowSec)}` : null,
    s.safety ? `Safety ${formatUpdated(s.safety.publishedAt, nowSec)}` : null,
    s.dews ? `stress ${formatUpdated(s.dews.computedAt, nowSec)}` : null,
  ].filter((part): part is string => part != null);
  const lines = [
    headline,
    `${safety} · ${dews}`,
    supplyLine,
    liquidityLine,
    formatYieldLine(s, nowSec),
    clocks.length > 0 ? `<i>${clocks.join(" · ")}</i>` : null,
    `<a href="https://pharos.watch/stablecoin/${encodeURIComponent(s.stablecoinId)}">Full report on Pharos</a>`,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
