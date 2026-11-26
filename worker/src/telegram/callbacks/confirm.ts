import { editMessage } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { forgetSubscriber, unsubscribeAll } from "../store/subscriber-lifecycle";
import { unixNow, upsertGlobalAlertTypes } from "../store/subscribers";
import {
  buildManageAlertsKeyboard,
  cmdForChat,
  formatDepegStepPercent,
} from "../webhook/telegram-webhook-messages";
import { sendAuditedTelegramReply } from "../webhook/telegram-webhook-replies";
import { decodeSubscribeTypes } from "./pick";
import {
  callbackChatType,
  callbackUsername,
  requireAdminForMutatingCallback,
  type CallbackContext,
  type CallbackHandler,
} from "./_shared";

/**
 * Stateless confirmations. The button carries the choice and its own expiry
 * (base-36 unix seconds), so nothing is stored between prompt and tap.
 *
 *   bulk:sa:<types>[-<step>]:<expiry>   follow every tracked coin
 *   bulk:ua:<expiry>                    remove every follow in this chat
 *   bulk:no                             cancel
 *   forget:yes:<expiry>                 delete this chat's data
 *   forget:no                           cancel
 */
const EXPIRED_TEXT = "This confirmation expired. Send the command again.";

export function isUnexpired(code: string | undefined): boolean {
  if (!code || !/^[0-9a-z]{1,8}$/.test(code)) return false;
  return parseInt(code, 36) > unixNow();
}

async function stripPromptButtons(ctx: CallbackContext, replacementText: string): Promise<void> {
  const messageId = ctx.cb.message?.message_id;
  if (messageId == null) return;
  await editMessage(ctx.chatId, messageId, replacementText, ctx.botToken, {
    disableWebPagePreview: true,
    replyMarkup: { inline_keyboard: [] },
  });
}

async function reply(
  ctx: CallbackContext,
  message: string,
  actionDetail: string,
  options: { recordReplyOutcome?: boolean; replyMarkup?: unknown } = {},
): Promise<void> {
  await sendAuditedTelegramReply(ctx.db, ctx.chatId, message, ctx.botToken, {
    actionDetail,
    recordReplyOutcome: options.recordReplyOutcome ?? true,
    ...(options.replyMarkup ? { replyMarkup: options.replyMarkup } : {}),
  });
}

export const handleBulkCallback: CallbackHandler = async (ctx) => {
  const [, op, ...rest] = ctx.parsed.parts;
  const chatType = callbackChatType(ctx.cb);
  if (op === "no" && rest.length === 0) {
    await stripPromptButtons(ctx, "Cancelled.");
    await ctx.answerCallback({ text: "Cancelled." });
    return;
  }
  const subscribe = op === "sa" && rest.length === 2 ? decodeSubscribeTypes(rest[0]) : null;
  const expiry = op === "sa" ? rest[1] : op === "ua" && rest.length === 1 ? rest[0] : undefined;
  if ((op === "sa" && !subscribe) || (op !== "sa" && op !== "ua")) {
    await ctx.answerCallback({ text: "Action not recognized." });
    return;
  }
  if (!isUnexpired(expiry)) {
    await ctx.answerCallback({ text: EXPIRED_TEXT });
    return;
  }
  if (!(await requireAdminForMutatingCallback(ctx.db, ctx.botToken, ctx.cb, ctx.chatId))) return;

  if (subscribe) {
    await upsertGlobalAlertTypes(ctx.db, ctx.chatId, callbackUsername(ctx.cb), subscribe.alertTypes, {
      depegWorseningBpsStep: subscribe.depegStep,
    });
    const step = subscribe.depegStep == null
      ? ""
      : ` Depeg step set to ${formatDepegStepPercent(subscribe.depegStep)}.`;
    await recordTelegramUsageEvent(ctx.db, { eventType: "subscribe", actionDetail: "all", outcome: "success" });
    await stripPromptButtons(ctx, "Confirmed.");
    await reply(
      ctx,
      `Done. You get ${[...subscribe.alertTypes].join(", ")} alerts for every active stablecoin.${step}`,
      "callback_bulk",
      { replyMarkup: chatType === "private" ? buildManageAlertsKeyboard("home") : undefined },
    );
  } else {
    await unsubscribeAll(ctx.db, ctx.chatId);
    await recordTelegramUsageEvent(ctx.db, { eventType: "unsubscribe", actionDetail: "all", outcome: "success" });
    await stripPromptButtons(ctx, "Confirmed.");
    await reply(
      ctx,
      `Done. This chat no longer follows any stablecoins. Send ${cmdForChat("start", chatType)} to set up again.`,
      "callback_bulk",
    );
  }
  await ctx.answerCallback({ text: "Applied." });
};

export const handleForgetCallback: CallbackHandler = async (ctx) => {
  const [, op, ...rest] = ctx.parsed.parts;
  if (op === "no" && rest.length === 0) {
    await stripPromptButtons(ctx, "Cancelled. Nothing was deleted.");
    await ctx.answerCallback({ text: "Cancelled. Nothing was deleted." });
    return;
  }
  if (op !== "yes" || rest.length !== 1) {
    await ctx.answerCallback({ text: "Action not recognized." });
    return;
  }
  if (callbackChatType(ctx.cb) !== "private") {
    await ctx.answerCallback({ text: "Open a private chat with PharosWatchBot." });
    return;
  }
  if (!isUnexpired(rest[0])) {
    await ctx.answerCallback({ text: "This confirmation expired. Send /forget again." });
    return;
  }
  await forgetSubscriber(ctx.db, ctx.chatId);
  await recordTelegramUsageEvent(ctx.db, { eventType: "command_forget", actionDetail: "callback", outcome: "success" });
  await stripPromptButtons(ctx, "Data deleted.");
  // The purge just deleted this chat's diagnostics row; do not recreate it.
  await reply(ctx, "Your data has been deleted. Send /start to begin again.", "callback_forget", {
    recordReplyOutcome: false,
  });
  await ctx.answerCallback({ text: "Deleted." });
};
