import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { unixNow } from "../store/subscribers";
import { cmdForChat } from "../webhook/telegram-webhook-messages";
import type { WebhookCommandHandler } from "./context";
import { BULK_CONFIRM_TTL_SEC } from "./action-runner";

/**
 * `/forget` two-step confirmation. The Delete button carries its own expiry,
 * so nothing is stored between the prompt and the tap.
 */
function buildForgetConfirmReplyMarkup(nowSec: number) {
  return {
    inline_keyboard: [[
      { text: "Delete my data", callback_data: `forget:yes:${(nowSec + BULK_CONFIRM_TTL_SEC).toString(36)}` },
      { text: "Cancel", callback_data: "forget:no" },
    ]],
  };
}

// What survives must match prepareSubscriberPurge in store/subscriber-lifecycle.ts.
const FORGET_CONFIRM_MESSAGE = [
  "This permanently deletes what Pharos Watch stores about this chat:",
  "- your coin and preset follows, global alerts, quiet hours and pause",
  "- queued alerts and the record of alerts sent to you",
  "- delivery diagnostics",
  "",
  "Pharos Watch keeps only:",
  "- ids of messages already processed, with this chat's id, so nothing runs twice (deleted after 7 days)",
  "- anonymous daily counts with no chat id",
].join("\n");

export const handleForget: WebhookCommandHandler = async (ctx) => {
  if (ctx.chatType !== "private") {
    const unsubCmd = cmdForChat("unsubscribe", ctx.chatType);
    await ctx.replyToChat(
      escapeHtml(
        `Removing @${TELEGRAM_BOT_USERNAME} from this group automatically deletes this group's data (or an admin can send ${unsubCmd} all to stop alerts). To delete your personal data, send /forget in a private chat with @${TELEGRAM_BOT_USERNAME}.`,
      ),
    );
    await recordTelegramUsageEvent(ctx.db, {
      eventType: "command_forget",
      actionDetail: "command",
      outcome: "failure",
      failureClass: "not_private",
    });
    return;
  }

  await ctx.replyToChatWithMarkup(FORGET_CONFIRM_MESSAGE, {
    replyMarkup: buildForgetConfirmReplyMarkup(ctx.operationNowSec ?? unixNow()),
  });
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "command_forget",
    actionDetail: "command",
    outcome: "prompted",
  });
};
