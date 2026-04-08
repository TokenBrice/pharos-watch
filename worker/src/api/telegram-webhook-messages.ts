import { escapeHtml } from "../lib/telegram";
import type { ResolvedCoin } from "../lib/telegram-alerts";
import type { SubscriberRow, SubscriptionRow } from "./telegram-webhook-shared";
import { STABLECOIN_BY_ID } from "./telegram-webhook-shared";

export function buildNotFoundMessage(ticker: string, suggestion?: ResolvedCoin): string {
  const lines = [`Ticker "${ticker}" not found.`];
  if (suggestion) {
    lines.push(`Did you mean ${suggestion.symbol} (${suggestion.id})?`);
  }
  lines.push("You can also use the exact Pharos coin id when a ticker is ambiguous.");
  return escapeHtml(lines.join("\n"));
}

export function buildUnsubscribeSuccessMessage(coins: ResolvedCoin[]): string {
  return escapeHtml([
    `Removed ${coins.length} coin subscription${coins.length === 1 ? "" : "s"}.`,
    "Coins:",
    formatCoinLines(coins),
  ].join("\n"));
}

export function buildSubscriptionSummaryMessage(
  header: string,
  subscriptions: SubscriptionRow[],
): string {
  const lines = [header, `Coins (${subscriptions.length}):`];
  for (const row of subscriptions) {
    const coin = STABLECOIN_BY_ID.get(row.stablecoin_id);
    const label = coin ? `${coin.symbol} (${coin.id})` : row.stablecoin_id;
    lines.push(`- ${label}: ${describeSubscriptionSettings(row)}`);
  }
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
        ? `${formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc)} UTC`
        : "Off"
    }`,
  ].join("\n"));
}

export function buildListMessage(
  subscriber: SubscriberRow | null,
  subscriptions: SubscriptionRow[],
): string {
  if (!subscriber && subscriptions.length === 0) {
    return "No active subscriptions. Use /subscribe to get started.";
  }

  const lines = [
    `All stablecoins: ${describeGlobalAlertSettings(subscriber)}`,
    `Quiet hours: ${
      subscriber?.quiet_hours_enabled
        ? `${formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc)} UTC`
        : "Off"
    }`,
    `Coins (${subscriptions.length}):`,
  ];

  if (subscriptions.length === 0) {
    lines.push("None");
  } else {
    const sorted = [...subscriptions].sort((a, b) => {
      const aCoin = STABLECOIN_BY_ID.get(a.stablecoin_id);
      const bCoin = STABLECOIN_BY_ID.get(b.stablecoin_id);
      const aSymbol = aCoin?.symbol ?? a.stablecoin_id;
      const bSymbol = bCoin?.symbol ?? b.stablecoin_id;
      return aSymbol.localeCompare(bSymbol) || a.stablecoin_id.localeCompare(b.stablecoin_id);
    });
    for (const row of sorted) {
      const coin = STABLECOIN_BY_ID.get(row.stablecoin_id);
      const label = coin ? `${coin.symbol} (${coin.id})` : row.stablecoin_id;
      lines.push(`- ${label}: ${describeSubscriptionSettings(row)}`);
    }
  }

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
    labels.push("Safety");
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
  return `${String(startHourUtc).padStart(2, "0")}-${String(endHourUtc).padStart(2, "0")}`;
}
