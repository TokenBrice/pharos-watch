import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { encodeWatchlistToken } from "../../lib/telegram-watchlist-token";
import { loadPresetSubscriptions, loadSubscriptionRowsByChat } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

/**
 * `/export` — emit a portable base64url token of the chat's explicit coin
 * follows + the alert types it uses + followed presets, so it can be re-applied
 * elsewhere via `/import`. Read-only; safe in any chat.
 */
export const handleExport: WebhookCommandHandler = async (ctx) => {
  const { db, chatId } = ctx;
  const [subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriptionRowsByChat(db, chatId),
    loadPresetSubscriptions(db, chatId),
  ]);

  const coinIds = subscriptions.map((row) => row.stablecoin_id);
  const presetIds = presetSubscriptions.map((row) => row.preset_id);
  if (coinIds.length === 0 && presetIds.length === 0) {
    await ctx.replyToChat(
      "Nothing to export yet. Use /subscribe (or /presets) first, then /export to copy your watchlist to another chat.",
    );
    return;
  }

  const alertTypes = new Set<string>();
  for (const row of subscriptions) {
    if (row.alert_dews) alertTypes.add("dews");
    if (row.alert_depeg) alertTypes.add("depeg");
    if (row.alert_safety) alertTypes.add("safety");
    if (row.alert_launch) alertTypes.add("launch");
    if (row.alert_reserve) alertTypes.add("reserve");
  }
  for (const row of presetSubscriptions) {
    if (row.alert_dews) alertTypes.add("dews");
    if (row.alert_depeg) alertTypes.add("depeg");
    if (row.alert_safety) alertTypes.add("safety");
  }

  const token = encodeWatchlistToken({ coinIds, alertTypes: [...alertTypes], presetIds });
  await ctx.replyToChat(
    [
      `Your watchlist token (${coinIds.length} coins, ${presetIds.length} presets):`,
      `<pre>${escapeHtml(token)}</pre>`,
      "Send it to another chat as <code>/import &lt;token&gt;</code> to copy these follows.",
    ].join("\n"),
  );
  await recordTelegramUsageEvent(db, { eventType: "subscribe", actionDetail: "export", outcome: "success" });
};
