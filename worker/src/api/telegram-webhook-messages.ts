import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { formatRelativeAgeSeconds, formatRelativeDurationSeconds } from "@shared/lib/relative-time";
import { escapeHtml, type InlineKeyboardButton } from "../lib/telegram";
import { formatTelegramAge } from "../lib/telegram-format-age";
import { MANAGE_PAGE_SIZE, isPausedSentinel } from "../lib/telegram-constants";
import { buildTelegramMiniAppUrl } from "../lib/telegram-webhook-registration";
import type { ResolvedCoin } from "../lib/telegram-alerts";
import type { TelegramPresetDefinition, TelegramPresetId } from "../lib/telegram-presets";
import { isQuietHoursActive } from "../lib/telegram-quiet-hours";
import { formatTelegramCompactUsd, formatTelegramSignedCompactUsd } from "./telegram-format";
import type { PresetSubscriptionRow, SubscriberRow, SubscriptionRow } from "./telegram-webhook-shared";
import { STABLECOIN_BY_ID } from "./telegram-webhook-shared";
import type { StatusForCoin } from "./telegram-webhook-status";

// Re-export so existing callers importing this constant from this module keep working.
export { MANAGE_PAGE_SIZE };

const GLOBAL_SAFETY_LABEL = "Safety (downgrades; 3-point drop when scored)";

function formatDepegLabel(step: number | null | undefined): string {
  return step != null ? `Depeg +${step}bps` : "Depeg";
}

export function buildNotFoundMessage(ticker: string, suggestion?: ResolvedCoin): string {
  const lines = [`Ticker or preset "${ticker}" not found.`];
  if (suggestion) {
    lines.push(`Did you mean ${suggestion.symbol} (${suggestion.id})?`);
  }
  lines.push("You can also use the exact Pharos coin id when a ticker is ambiguous.");
  lines.push("Use /presets to browse preset watchlists.");
  lines.push("Example: /subscribe dews usd-top25");
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

function sortSubscriptions(subscriptions: SubscriptionRow[]): SubscriptionRow[] {
  return [...subscriptions].sort((a, b) => {
    const aCoin = STABLECOIN_BY_ID.get(a.stablecoin_id);
    const bCoin = STABLECOIN_BY_ID.get(b.stablecoin_id);
    const aSymbol = aCoin?.symbol ?? a.stablecoin_id;
    const bSymbol = bCoin?.symbol ?? b.stablecoin_id;
    return aSymbol.localeCompare(bSymbol) || a.stablecoin_id.localeCompare(b.stablecoin_id);
  });
}

function formatCoinLabel(stablecoinId: string): string {
  const coin = STABLECOIN_BY_ID.get(stablecoinId);
  return coin ? `${coin.symbol} (${coin.id})` : stablecoinId;
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

export function buildGlobalAlertSummaryMessage(header: string, subscriber: SubscriberRow | null): string {
  return escapeHtml(
    [
      header,
      `All stablecoins: ${describeGlobalAlertSettings(subscriber)}`,
      `Quiet hours: ${
        subscriber?.quiet_hours_enabled
          ? formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc, subscriber.timezone)
          : "Off"
      }`,
    ].join("\n"),
  );
}

export function buildListMessage(
  subscriber: SubscriberRow | null,
  subscriptions: SubscriptionRow[],
  presetSubscriptions: PresetSubscriptionRow[] = [],
  nowSec = Math.floor(Date.now() / 1000),
): string {
  if (!subscriber && subscriptions.length === 0 && presetSubscriptions.length === 0) {
    return "No active subscriptions. Use /subscribe to get started, or try /presets for preset watchlists.";
  }

  const lines = [
    `All stablecoins: ${describeGlobalAlertSettings(subscriber)}`,
    `Quiet hours: ${formatQuietHoursStatus(subscriber, nowSec)}`,
    formatSnoozeLine(subscriber?.alert_snooze_until_ts ?? null, nowSec),
    `Dynamic presets (${presetSubscriptions.length}):`,
  ];

  if (presetSubscriptions.length === 0) {
    lines.push("None");
  } else {
    for (const row of presetSubscriptions) {
      lines.push(`- ${row.preset_id}: ${describePresetSubscriptionSettings(row)}`);
    }
  }

  lines.push(`Coins (${subscriptions.length}):`);

  if (subscriptions.length === 0) {
    lines.push("None");
  } else {
    const sorted = sortSubscriptions(subscriptions);
    for (const row of sorted) {
      lines.push(
        `- ${formatCoinLabel(row.stablecoin_id)}: ${describeSubscriptionSettings(row, nowSec, { perCoinTag: true })}`,
      );
    }
  }

  lines.push("Precedence: per-coin > preset > all-stablecoins. A per-coin Muted overrides the rest.");
  lines.push("Tip: use /presets to browse dynamic watchlists, or /unsnooze to clear alert snooze.");
  return escapeHtml(lines.join("\n"));
}

export function buildPresetCatalogMessage(definitions: TelegramPresetDefinition[]): string {
  const pegPresets = definitions.filter((definition) => definition.category === "peg-leaders");
  const marketCapPresets = definitions.filter((definition) => definition.category === "market-cap");
  const lines = [
    "Preset Watchlists",
    "",
    "Peg Leaders:",
    ...pegPresets.map((definition) => `- ${definition.id}: ${definition.description}`),
    "",
    "Market Cap:",
    ...marketCapPresets.map((definition) => `- ${definition.id}: ${definition.description}`),
    "",
    "Examples:",
    "- /subscribe dews usd-top25",
    "- /subscribe dews usd-top-25",
    "- /subscribe safety mcap-ge-1b",
    "- /unsubscribe eur-top10",
  ];
  return escapeHtml(lines.join("\n"));
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
  const shown = sorted.slice(0, 12);
  const lines = [
    `Preset watchlists followed: ${formatPresetLabelList(options.presetIds, options.presetLabelById)}`,
    `Current dynamic coverage: ${options.presetCoinCount} coin${options.presetCoinCount === 1 ? "" : "s"}.`,
  ];
  if (sorted.length > 0) {
    lines.push(`Direct coin preferences updated (${sorted.length}):`);
    for (const row of shown) {
      lines.push(`- ${formatCoinLabel(row.stablecoin_id)}: ${describeSubscriptionSettings(row)}`);
    }
    appendTruncationLine(lines, sorted.length, shown.length);
  }
  lines.push("Preset membership updates automatically; direct coin preferences stay independent.");
  lines.push("Use /list to review both sources and per-coin settings.");
  return escapeHtml(lines.join("\n"));
}

export function buildPresetUnsubscribeSummaryMessage(
  coins: ResolvedCoin[],
  options: {
    presetIds: readonly TelegramPresetId[];
    presetLabelById: ReadonlyMap<string, string>;
    presetCoinCount: number | null;
  },
): string {
  const lines = [
    `Preset watchlists removed: ${formatPresetLabelList(options.presetIds, options.presetLabelById)}`,
    options.presetCoinCount == null
      ? "Stopped dynamic coverage; current membership was unavailable for preview."
      : `Stopped dynamic coverage for ${options.presetCoinCount} current coin${options.presetCoinCount === 1 ? "" : "s"}.`,
    "Direct coin preferences and overlapping preset follows were preserved.",
  ];
  if (coins.length > 0) {
    const sortedCoins = [...coins].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
    const shownCoins = sortedCoins.slice(0, 12);
    lines.push(`Explicitly removed direct coin preferences (${coins.length}):`, formatCoinLines(shownCoins));
    appendTruncationLine(lines, sortedCoins.length, shownCoins.length);
  }
  lines.push("Use /list to confirm the remaining subscriptions.");
  return escapeHtml(lines.join("\n"));
}

export function describeSubscriptionSettings(
  row: SubscriptionRow,
  nowSec: number = Math.floor(Date.now() / 1000),
  options: { perCoinTag?: boolean } = {},
): string {
  const labels: string[] = [];

  if (row.alert_dews) {
    labels.push(row.dews_min_band ? `DEWS>=${row.dews_min_band}` : "DEWS");
  }
  if (row.alert_depeg) {
    labels.push(formatDepegLabel(row.depeg_worsening_bps_step));
  }
  if (row.alert_safety) {
    if (row.safety_mode === "downgrade-only") {
      labels.push("Safety downgrade-only");
    } else if (row.safety_mode === "upgrade-only") {
      labels.push("Safety upgrade-only");
    } else {
      labels.push("Safety");
    }
  }
  if (row.alert_launch) {
    labels.push("Launch");
  }
  if (row.alert_reserve) {
    labels.push("Reserve");
  }
  if (row.alert_freeze) {
    labels.push("Freeze");
  }

  // C74: in /list (perCoinTag) make the precedence model legible — an
  // all-flags-0 row is a per-coin Muted that suppresses preset/global defaults
  // (the C02 per-coin `off` precedence), and a flagged row is tagged so the
  // active per-coin override lane is visible. Other callers keep the bare label.
  let base: string;
  if (labels.length === 0) {
    base = options.perCoinTag ? "Muted (overrides defaults)" : "Muted";
  } else {
    base = options.perCoinTag ? `${labels.join(", ")} · per-coin` : labels.join(", ");
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
  const labels: string[] = [];
  if (row.alert_dews) labels.push("DEWS");
  if (row.alert_depeg) {
    labels.push(formatDepegLabel(row.depeg_worsening_bps_step));
  }
  if (row.alert_safety) labels.push("Safety");
  return labels.join(", ") || "Muted";
}

export function describeGlobalAlertSettings(subscriber: SubscriberRow | null): string {
  if (!subscriber) return "None";
  const labels: string[] = [];

  if (subscriber.global_alert_dews) {
    labels.push("DEWS");
  }
  if (subscriber.global_alert_depeg) {
    labels.push(formatDepegLabel(subscriber.global_depeg_worsening_bps_step));
  }
  if (subscriber.global_alert_safety) {
    labels.push(GLOBAL_SAFETY_LABEL);
  }
  if (subscriber.global_alert_launch) {
    labels.push("Launch");
  }
  if (subscriber.global_alert_reserve) {
    labels.push("Reserve");
  }
  if (subscriber.global_alert_freeze) {
    labels.push("Freeze");
  }

  return labels.join(", ") || "None";
}

function formatCoinLines(coins: ResolvedCoin[]): string {
  return coins.map((coin) => `- ${coin.symbol} (${coin.id})`).join("\n") || "None";
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

function formatSnoozeLine(snoozeUntilSec: number | null, nowSec: number): string {
  if (snoozeUntilSec == null || snoozeUntilSec <= nowSec) return "Snooze: Off";
  if (isPausedSentinel(snoozeUntilSec)) return "Paused (indefinite)";
  return `Snoozed for ${formatSnoozeDuration(snoozeUntilSec - nowSec)}`;
}

function formatSnoozeDuration(seconds: number): string {
  return formatRelativeDurationSeconds(seconds, {
    nowLabel: "less than 1 min",
    unitStyle: "short",
    rounding: "round",
    dayThresholdSec: 48 * 3600,
  });
}

function formatAge(ts: number | null | undefined, nowSec = Math.floor(Date.now() / 1000)): string {
  return formatTelegramAge(ts, nowSec);
}

function formatElapsed(ts: number | null | undefined, nowSec = Math.floor(Date.now() / 1000)): string {
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

export function buildStatusDiscoveryKeyboard(
  stablecoinId: string,
  options: { includeMiniAppButton?: boolean; miniAppPayload?: string } = {},
): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  const rows: InlineKeyboardButton[][] = [
    [
      { text: "Why?", callback_data: `why:${stablecoinId}` },
      { text: "Coverage", callback_data: `coverage:${stablecoinId}` },
      { text: "Subscribe", callback_data: `quicksub:${stablecoinId}` },
    ],
  ];
  if (options.includeMiniAppButton) {
    rows.push([
      {
        text: "Open in app",
        web_app: { url: buildTelegramMiniAppUrl(options.miniAppPayload ?? formatCoinPayload(stablecoinId)) },
      },
    ]);
  }
  return { inline_keyboard: rows };
}

/** Inline keyboard with a single `[ Manage ]` entry button, attached to /list. */
export function buildManageEntryKeyboard(options: { includeMiniAppButton?: boolean } = {}): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  const rows: InlineKeyboardButton[][] = [[{ text: "Manage", callback_data: "manage:page:0" }]];
  if (options.includeMiniAppButton)
    rows.push([{ text: "Open in app", web_app: { url: buildTelegramMiniAppUrl("watchlist") } }]);
  return { inline_keyboard: rows };
}

export function buildMiniAppOnlyKeyboard(
  text = "Open control panel",
  payload = "watchlist",
): {
  inline_keyboard: InlineKeyboardButton[][];
} {
  return { inline_keyboard: [[{ text, web_app: { url: buildTelegramMiniAppUrl(payload) } }]] };
}

/**
 * Paginated keyboard for watchlist management. Renders up to `MANAGE_PAGE_SIZE`
 * rows of `[ ❌ <SYMBOL> ]` buttons followed by a Prev/Next nav row when needed.
 * Caller clamps `page` to a valid range; this helper trusts the input.
 */
export function buildManageWatchlistKeyboard(
  subscriptions: SubscriptionRow[],
  page: number,
): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const sorted = sortSubscriptions(subscriptions);
  const totalPages = Math.max(1, Math.ceil(sorted.length / MANAGE_PAGE_SIZE));
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = clampedPage * MANAGE_PAGE_SIZE;
  const slice = sorted.slice(start, start + MANAGE_PAGE_SIZE);

  const rows: Array<Array<{ text: string; callback_data: string }>> = slice.map((row) => {
    const coin = STABLECOIN_BY_ID.get(row.stablecoin_id);
    const symbol = coin?.symbol ?? row.stablecoin_id;
    return [
      {
        text: `❌ ${symbol}`,
        callback_data: `unsub:${row.stablecoin_id}`,
      },
    ];
  });

  if (totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (clampedPage > 0) {
      nav.push({ text: "◀ Prev", callback_data: `manage:page:${clampedPage - 1}` });
    }
    if (clampedPage < totalPages - 1) {
      nav.push({ text: "Next ▶", callback_data: `manage:page:${clampedPage + 1}` });
    }
    if (nav.length > 0) rows.push(nav);
  }

  return { inline_keyboard: rows };
}

/** Header text rendered above the manage keyboard. */
export function buildManageWatchlistMessage(subscriptions: SubscriptionRow[], page: number): string {
  if (subscriptions.length === 0) {
    return escapeHtml("No coin subscriptions to manage. Use /subscribe to add some.");
  }
  const totalPages = Math.max(1, Math.ceil(subscriptions.length / MANAGE_PAGE_SIZE));
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  const pageLine = totalPages > 1 ? ` Page ${clampedPage + 1}/${totalPages}.` : "";
  return escapeHtml(
    `Manage watchlist (${subscriptions.length} coin${subscriptions.length === 1 ? "" : "s"}).${pageLine} Tap a row to remove that coin.`,
  );
}

export function buildStatusMessage(symbol: string, s: StatusForCoin): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const priceLine =
    s.priceUsd != null
      ? `Price: $${s.priceUsd.toFixed(4)}${s.priceUpdatedAt ? ` (${formatAge(s.priceUpdatedAt, nowSec)})` : ""}`
      : "Price: no recent quote";
  const dewsLine = s.dews
    ? `DEWS: ${s.dews.band} (score ${s.dews.score}, ${formatAge(s.dews.computedAt, nowSec)})`
    : "DEWS: no recent signal";
  const safetyLine = s.safety
    ? `Safety: ${s.safety.grade}${s.safety.score != null ? ` (${s.safety.score})` : ""} [${s.safety.model.toUpperCase()} ${s.safety.methodologyVersion}], ${formatAge(s.safety.publishedAt, nowSec)}`
    : s.safetyUnavailableReason
      ? "Safety: temporarily unavailable"
      : "Safety: UNKNOWN";
  const depegLine =
    s.depeg.status === "active"
      ? `Depeg: ACTIVE — ${s.depeg.direction} peg, peak ${(s.depeg.peakDeviationBps / 100).toFixed(1)}%, started ${formatElapsed(s.depeg.startedAt, nowSec)}`
      : "Depeg: stable";
  const supply = formatTelegramCompactUsd(s.supplyUsd);
  const supplyLine = supply
    ? `Supply: ${supply}${s.stablecoinsUpdatedAt ? ` (${formatAge(s.stablecoinsUpdatedAt, nowSec)})` : ""}`
    : null;
  const liquidityTvl = formatTelegramCompactUsd(s.liquidity?.totalTvlUsd);
  const liquidityLine = s.liquidity
    ? `Liquidity: ${s.liquidity.score ?? "NR"}${liquidityTvl ? `, TVL ${liquidityTvl}` : ""} (${formatAge(s.liquidity.updatedAt, nowSec)})`
    : null;
  const yieldLine = s.yield
    ? `Yield: ${s.yield.apy30d.toFixed(2)}% 30d at ${escapeHtml(s.yield.source)}${
        s.yield.pharosYieldScore != null
          ? `, PYS ${Math.round(s.yield.pharosYieldScore)}`
          : s.yield.pysUnavailableReason
            ? ", PYS unavailable"
            : ""
      }`
    : null;
  const flowSigned = s.flow ? formatTelegramSignedCompactUsd(s.flow.netFlowUsd) : null;
  const flowLine = s.flow && flowSigned ? `Flow 24h: ${flowSigned} (${formatAge(s.flow.updatedAt, nowSec)})` : null;
  const lines = [
    `<b>${escapeHtml(symbol)}</b>`,
    priceLine,
    supplyLine,
    dewsLine,
    safetyLine,
    depegLine,
    liquidityLine,
    yieldLine,
    flowLine,
    `<a href="https://pharos.watch/stablecoin/${s.stablecoinId}">View on Pharos</a>`,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
