import { handleSettingsCommand } from "../webhook/telegram-webhook-settings";
import { buildManageAlertsKeyboard, describeDeliveryState, describeFollows, followsNothing } from "../webhook/telegram-webhook-messages";
import { TELEGRAM_PRESET_LABEL_BY_ID } from "../common/presets";
import { loadPresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import type { WebhookCommandHandler } from "./context";

/**
 * Private chats hand settings off to the Mini App; groups (no Mini App) keep
 * the inline settings keyboard.
 */
export const handleSettings: WebhookCommandHandler = async (ctx, args) => {
  if (ctx.chatType !== "private") {
    await handleSettingsCommand(ctx.db, ctx.botToken, ctx.chatId, ctx.username, args, {
      includeMiniAppButton: false,
    });
    return;
  }
  const nowSec = ctx.operationNowSec ?? unixNow();
  const [subscriber, subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriberByChat(ctx.db, ctx.chatId),
    loadSubscriptionRowsByChat(ctx.db, ctx.chatId),
    loadPresetSubscriptions(ctx.db, ctx.chatId),
  ]);
  const summary = followsNothing({ subscriber, subscriptions, presetSubscriptions })
    ? ["You don't follow any stablecoins yet."]
    : [
        ...describeFollows({ subscriber, subscriptions, presetSubscriptions, presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID, nowSec }),
        ...describeDeliveryState(subscriber, nowSec),
      ];
  await ctx.replyToChatWithMarkup(
    ["<b>Alert settings</b>", ...summary, "Add coins, set quiet hours or tune alerts in Manage Alerts."].join("\n"),
    { replyMarkup: buildManageAlertsKeyboard("settings") },
  );
};
