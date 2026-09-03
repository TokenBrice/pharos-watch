import { buildListMessage, buildManageEntryKeyboard, buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { buildTelegramMiniAppUrl } from "../../lib/telegram/webhook-registration";
import {
  loadPresetSubscriptions,
  loadSubscriberByChat,
  loadSubscriptionRowsByChat,
} from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

export const handleList: WebhookCommandHandler = async (ctx) => {
  const { db, chatId } = ctx;
  const isPrivateChat = ctx.chatType === "private";
  const subscriber = await loadSubscriberByChat(db, chatId);

  const [subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriptionRowsByChat(db, chatId),
    loadPresetSubscriptions(db, chatId),
  ]);

  const rows = subscriptions;
  if (!subscriber && rows.length === 0 && presetSubscriptions.length === 0) {
    const message = "No active subscriptions. Use /subscribe to get started, or try /presets for preset watchlists.";
    if (isPrivateChat) {
      await ctx.replyToChatWithMarkup(message, {
        replyMarkup: {
          inline_keyboard: [
            [{ text: "Open control panel", web_app: { url: buildTelegramMiniAppUrl("watchlist") } }],
            [{ text: "Browse presets", web_app: { url: buildTelegramMiniAppUrl("presets") } }],
          ],
        },
      });
      return;
    }
    await ctx.replyToChat(message);
    return;
  }

  const message = buildListMessage(subscriber, rows, presetSubscriptions);
  // Only attach the [Manage] keyboard when there is at least one explicit
  // coin subscription — preset-only or quiet-hours-only chats have nothing
  // to manage from this surface.
  const replyMarkup = rows.length > 0
    ? buildManageEntryKeyboard({ includeMiniAppButton: isPrivateChat })
    : isPrivateChat
      ? buildMiniAppOnlyKeyboard("Open control panel")
      : undefined;
  await ctx.replyToChatWithMarkup(message, replyMarkup ? { replyMarkup } : {});
};
