import { TELEGRAM_PRESET_LABEL_BY_ID } from "../common/presets";
import { buildListMessage, buildManageAlertsKeyboard, followsNothing } from "../webhook/telegram-webhook-messages";
import { buildOnboardingKeyboard } from "../webhook/telegram-webhook-setup";
import { loadPresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import { loadTelegramChatHealthDiagnostics } from "../store/usage-analytics";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

export const handleList: WebhookCommandHandler = async (ctx) => {
  const { db, chatId } = ctx;
  const [subscriber, subscriptions, presetSubscriptions, diagnostics] = await Promise.all([
    loadSubscriberByChat(db, chatId),
    loadSubscriptionRowsByChat(db, chatId),
    loadPresetSubscriptions(db, chatId),
    // Diagnostics only feed the "Last alert delivered" line; a failed read drops that line.
    loadTelegramChatHealthDiagnostics(db, chatId).catch(() => null),
  ]);

  if (followsNothing({ subscriber, subscriptions, presetSubscriptions })) {
    const message = "You don't follow any stablecoins yet.";
    if (ctx.chatType === "private") {
      await ctx.replyToChatWithMarkup(message, { replyMarkup: buildOnboardingKeyboard() });
      return;
    }
    await ctx.replyToChat(`${message} Admins can start with /subscribe@PharosWatchBot usd-top25.`);
    return;
  }

  const message = buildListMessage({
    subscriber,
    subscriptions,
    presetSubscriptions,
    presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
    lastDeliveryAt: diagnostics?.lastSuccessfulDeliveryAt ?? null,
  });
  await replyWithOptionalMiniApp(ctx, message, buildManageAlertsKeyboard());
};
