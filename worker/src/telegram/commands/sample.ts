import { isGroupChatType } from "../webhook/telegram-webhook-auth";
import { buildManageAlertsKeyboard, followsNothing } from "../webhook/telegram-webhook-messages";
import { buildOnboardingKeyboard, buildSampleAlertMessage } from "../webhook/telegram-webhook-setup";
import { loadPresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import type { WebhookCommandHandler } from "./context";

/**
 * `/sample` and `?start=sample`: one example alert, taken from the public
 * samples that the formatter contract test keeps identical to real output.
 * It never reads live risk data or changes subscriptions.
 */
export const handleSample: WebhookCommandHandler = async (ctx) => {
  if (isGroupChatType(ctx.chatType) || ctx.chatType === "channel") {
    await ctx.replyToChat("Only available in private chats.");
    return;
  }
  const [subscriber, subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriberByChat(ctx.db, ctx.chatId),
    loadSubscriptionRowsByChat(ctx.db, ctx.chatId),
    loadPresetSubscriptions(ctx.db, ctx.chatId),
  ]);
  const replyMarkup = followsNothing({ subscriber, subscriptions, presetSubscriptions })
    ? buildOnboardingKeyboard({ includeSample: false, includeManageAlerts: true })
    : buildManageAlertsKeyboard("home");
  await ctx.replyToChatWithMarkup(buildSampleAlertMessage(), { replyMarkup });
};
