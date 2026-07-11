import { answerCallbackQuery, editMessage } from "../../lib/telegram";
import {
  MANAGE_PAGE_SIZE,
  buildManageWatchlistKeyboard,
  buildManageWatchlistMessage,
} from "../telegram-webhook-messages";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { loadSubscriptionRowsByChat } from "../telegram-webhook-store";
import type { SubscriptionRow } from "../telegram-webhook-shared";
import {
  hasExactParts,
  type CallbackHandler,
  type TelegramCallbackQuery,
} from "./_shared";

export async function renderManageWatchlistPage(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  params: {
    chatId: string;
    subscriptions: SubscriptionRow[];
    requestedPage: number;
    ackText: string;
    beforeIrreversibleEffect?: (kind: string) => Promise<void>;
    answerCallback?: (options?: { text?: string }) => Promise<void>;
  },
): Promise<void> {
  const { chatId, subscriptions, requestedPage, ackText } = params;
  const answer = params.answerCallback
    ?? ((options?: { text?: string }) => answerCallbackQuery(cb.id, botToken, options));
  const totalPages = Math.max(1, Math.ceil(subscriptions.length / MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const messageId = cb.message?.message_id;
  const text = buildManageWatchlistMessage(subscriptions, page);
  const replyMarkup = subscriptions.length === 0
    ? { inline_keyboard: [] }
    : buildManageWatchlistKeyboard(subscriptions, page);

  if (messageId != null) {
    await params.beforeIrreversibleEffect?.("manage-edit");
    const edited = await editMessage(chatId, messageId, text, botToken, {
      disableWebPagePreview: true,
      replyMarkup,
    });
    if (edited) {
      await answer({ text: ackText });
      return;
    }
  }
  {
    await params.beforeIrreversibleEffect?.("manage-reply");
    await sendAuditedTelegramReply(db, chatId, text, botToken, {
      replyMarkup,
      actionDetail: "callback_manage",
    });
  }
  await answer({ text: ackText });
}

async function renderManagePage(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  requestedPage: number,
  ackText: string,
  effect: {
    beforeIrreversibleEffect?: (kind: string) => Promise<void>;
    answerCallback?: (options?: { text?: string }) => Promise<void>;
  } = {},
): Promise<void> {
  const subscriptions = await loadSubscriptionRowsByChat(db, chatId);
  await renderManageWatchlistPage(db, botToken, cb, {
    chatId,
    subscriptions,
    requestedPage,
    ackText,
    ...effect,
  });
}

async function handleManagePage(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  effect: {
    beforeIrreversibleEffect?: (kind: string) => Promise<void>;
    answerCallback?: (options?: { text?: string }) => Promise<void>;
  } = {},
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    if (effect.answerCallback) await effect.answerCallback();
    else await answerCallbackQuery(cb.id, botToken);
    return;
  }
  const pageRaw = (cb.data ?? "").split(":")[2];
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 0) {
    if (effect.answerCallback) await effect.answerCallback({ text: "Action not recognized." });
    else await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await renderManagePage(db, botToken, cb, chatId, page, "", effect);
}

export const handleManageCallback: CallbackHandler = async ({
  db, botToken, cb, parsed, answerCallback, beforeIrreversibleEffect,
}) => {
  if (!hasExactParts(parsed.parts, 3) || parsed.arg !== "page") {
    await answerCallback({ text: "Action not recognized." });
    return;
  }
  await handleManagePage(db, botToken, cb, { beforeIrreversibleEffect, answerCallback });
};
