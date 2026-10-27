import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import { escapeHtml } from "../delivery/telegram";
import { isGroupChatType } from "../webhook/telegram-webhook-auth";
import { buildOnboardingKeyboard } from "../webhook/telegram-webhook-setup";
import type { WebhookCommandHandler } from "./context";

/**
 * `/sample` and `?start=sample`: one example alert, taken from the public
 * samples that the formatter contract test keeps identical to real output.
 * It never reads live data or changes subscriptions.
 */
function buildSampleAlertMessage(): string {
  return `${escapeHtml(TELEGRAM_PUBLIC_ALERT_SAMPLES.depeg.message)}\n\n<i>This was a sample alert.</i>`;
}

export const handleSample: WebhookCommandHandler = async (ctx) => {
  if (isGroupChatType(ctx.chatType) || ctx.chatType === "channel") {
    await ctx.replyToChat("Only available in private chats.");
    return;
  }
  await ctx.replyToChatWithMarkup(buildSampleAlertMessage(), { replyMarkup: buildOnboardingKeyboard({ includeSample: false }) });
};
