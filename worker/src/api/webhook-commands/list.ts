import { buildListMessage, buildManageEntryKeyboard } from "../telegram-webhook-messages";
import { loadPresetSubscriptions, loadSubscriberByChat } from "../telegram-webhook-store";
import type { SubscriptionRow } from "../telegram-webhook-shared";
import type { WebhookCommandHandler } from "./context";

export const handleList: WebhookCommandHandler = async (ctx) => {
  const { db, chatId } = ctx;
  const subscriber = await loadSubscriberByChat(db, chatId);

  const [subscriptions, presetSubscriptions] = await Promise.all([
    db
      .prepare(
        `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, dews_min_band, safety_mode, depeg_worsening_bps_step
           FROM telegram_subscriptions
          WHERE chat_id = ?
          ORDER BY stablecoin_id`,
      )
      .bind(chatId)
      .all<SubscriptionRow>(),
    loadPresetSubscriptions(db, chatId),
  ]);

  const rows = subscriptions.results ?? [];
  if (!subscriber && rows.length === 0 && presetSubscriptions.length === 0) {
    await ctx.replyToChat(
      "No active subscriptions. Use /subscribe to get started, or try /presets for preset watchlists.",
    );
    return;
  }

  const message = buildListMessage(subscriber, rows, presetSubscriptions);
  // Only attach the [Manage] keyboard when there is at least one explicit
  // coin subscription — preset-only or quiet-hours-only chats have nothing
  // to manage from this surface.
  const replyMarkup = rows.length > 0 ? buildManageEntryKeyboard() : undefined;
  await ctx.replyToChatWithMarkup(message, replyMarkup ? { replyMarkup } : {});
};
