import { escapeHtml } from "../lib/telegram";
import type { ResolvedCoin } from "../lib/telegram-alerts";
import type {
  TelegramPresetDefinition,
  TelegramPresetId,
} from "../lib/telegram-presets";
import type { SubscriberRow, SubscriptionRow } from "./telegram-webhook-shared";
import { STABLECOIN_BY_ID } from "./telegram-webhook-shared";
import type { StatusForCoin } from "./telegram-webhook-status";

const GLOBAL_SAFETY_LABEL = "Safety (downgrades; 3-point drop when scored)";

export function buildNotFoundMessage(ticker: string, suggestion?: ResolvedCoin): string {
  const lines = [`Ticker or preset "${ticker}" not found.`];
  if (suggestion) {
    lines.push(`Did you mean ${suggestion.symbol} (${suggestion.id})?`);
  }
  lines.push("You can also use the exact Pharos coin id when a ticker is ambiguous.");
  lines.push("Use /presets to browse preset watchlists.");
  return escapeHtml(lines.join("\n"));
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

export function buildUnsubscribeSuccessMessage(
  coins: ResolvedCoin[],
  options: UnsubscribeSummaryOptions = {},
): string {
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

export function buildGlobalAlertSummaryMessage(
  header: string,
  subscriber: SubscriberRow | null,
): string {
  return escapeHtml([
    header,
    `All stablecoins: ${describeGlobalAlertSettings(subscriber)}`,
    `Quiet hours: ${
      subscriber?.quiet_hours_enabled
        ? formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc)
        : "Off"
    }`,
  ].join("\n"));
}

export function buildListMessage(
  subscriber: SubscriberRow | null,
  subscriptions: SubscriptionRow[],
): string {
  if (!subscriber && subscriptions.length === 0) {
    return "No active subscriptions. Use /subscribe to get started, or try /presets for preset watchlists.";
  }

  const lines = [
    `All stablecoins: ${describeGlobalAlertSettings(subscriber)}`,
    `Quiet hours: ${
      subscriber?.quiet_hours_enabled
        ? formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc)
        : "Off"
    }`,
    `Coins (${subscriptions.length}):`,
  ];

  if (subscriptions.length === 0) {
    lines.push("None");
  } else {
    const sorted = sortSubscriptions(subscriptions);
    for (const row of sorted) {
      lines.push(`- ${formatCoinLabel(row.stablecoin_id)}: ${describeSubscriptionSettings(row)}`);
    }
  }

  lines.push("Tip: use /presets to browse preset watchlists.");
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
  },
): string {
  return buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions, {
    introLines: [`Preset watchlists: ${formatPresetLabelList(options.presetIds, options.presetLabelById)}`],
    maxRows: 12,
    footerLine: "Use /list to review the full set and per-coin settings.",
  });
}

export function buildPresetUnsubscribeSummaryMessage(
  coins: ResolvedCoin[],
  options: {
    presetIds: readonly TelegramPresetId[];
    presetLabelById: ReadonlyMap<string, string>;
  },
): string {
  const sortedCoins = [...coins].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
  const shownCoins = sortedCoins.slice(0, 12);
  const lines = [
    `Preset watchlists removed: ${formatPresetLabelList(options.presetIds, options.presetLabelById)}`,
    `Removed ${coins.length} coin subscription${coins.length === 1 ? "" : "s"}.`,
    "Coins:",
    formatCoinLines(shownCoins),
  ];
  appendTruncationLine(lines, sortedCoins.length, shownCoins.length, "Use /list to confirm the remaining subscriptions.");
  return escapeHtml(lines.join("\n"));
}

export function describeSubscriptionSettings(row: SubscriptionRow): string {
  const labels: string[] = [];

  if (row.alert_dews) {
    labels.push(row.dews_min_band ? `DEWS>=${row.dews_min_band}` : "DEWS");
  }
  if (row.alert_depeg) {
    labels.push(
      row.depeg_worsening_bps_step != null
        ? `Depeg +${row.depeg_worsening_bps_step}bps`
        : "Depeg",
    );
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

  return labels.join(", ") || "Muted";
}

export function describeGlobalAlertSettings(subscriber: SubscriberRow | null): string {
  if (!subscriber) return "None";
  const labels: string[] = [];

  if (subscriber.global_alert_dews) {
    labels.push("DEWS");
  }
  if (subscriber.global_alert_depeg) {
    labels.push("Depeg");
  }
  if (subscriber.global_alert_safety) {
    labels.push(GLOBAL_SAFETY_LABEL);
  }
  if (subscriber.global_alert_launch) {
    labels.push("Launch");
  }

  return labels.join(", ") || "None";
}

export function formatCoinLines(coins: ResolvedCoin[]): string {
  return coins.map((coin) => `- ${coin.symbol} (${coin.id})`).join("\n") || "None";
}

export function formatQuietHours(startHourUtc: number | null | undefined, endHourUtc: number | null | undefined): string {
  if (startHourUtc == null || endHourUtc == null) return "Off";
  const pad = (h: number) => String(h).padStart(2, "0");
  return `${pad(startHourUtc)}:00–${pad(endHourUtc)}:00 UTC`;
}

export function buildStatusMessage(symbol: string, s: StatusForCoin): string {
  const priceLine =
    s.priceUsd != null
      ? `Price: $${s.priceUsd.toFixed(4)}`
      : "Price: no recent quote";
  const dewsLine = s.dews
    ? `DEWS: ${s.dews.band} (score ${s.dews.score})`
    : "DEWS: no recent signal";
  const safetyLine = s.safety
    ? `Safety: ${s.safety.grade}${s.safety.score != null ? ` (${s.safety.score})` : ""}`
    : "Safety: UNKNOWN";
  const depegLine =
    s.depeg.status === "active"
      ? `Depeg: ACTIVE — ${s.depeg.direction} peg, peak ${(s.depeg.peakDeviationBps / 100).toFixed(1)}%`
      : "Depeg: stable";
  const lines = [
    `<b>${escapeHtml(symbol)}</b>`,
    priceLine,
    dewsLine,
    safetyLine,
    depegLine,
    `<a href="https://pharos.watch/stablecoin/${s.stablecoinId}">View on Pharos</a>`,
  ];
  return lines.join("\n");
}
