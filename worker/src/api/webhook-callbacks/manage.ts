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
  },
): Promise<void> {
  const { chatId, subscriptions, requestedPage, ackText } = params;
  const totalPages = Math.max(1, Math.ceil(subscriptions.length / MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const messageId = cb.message?.message_id;
  const text = buildManageWatchlistMessage(subscriptions, page);
  const replyMarkup = subscriptions.length === 0
    ? { inline_keyboard: [] }
    : buildManageWatchlistKeyboard(subscriptions, page);

  if (messageId != null) {
    const edited = await editMessage(chatId, messageId, text, botToken, {
      disableWebPagePreview: true,
      replyMarkup,
    });
    if (edited) {
      await answerCallbackQuery(cb.id, botToken, { text: ackText });
      return;
    }
  }
  {
    await sendAuditedTelegramReply(db, chatId, text, botToken, {
      replyMarkup,
      actionDetail: "callback_manage",
    });
  }
  await answerCallbackQuery(cb.id, botToken, { text: ackText });
}

async function renderManagePage(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  requestedPage: number,
  ackText: string,
): Promise<void> {
  const subscriptions = await loadSubscriptionRowsByChat(db, chatId);
  await renderManageWatchlistPage(db, botToken, cb, {
    chatId,
    subscriptions,
    requestedPage,
    ackText,
  });
}

async function handleManagePage(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }
  const pageRaw = (cb.data ?? "").split(":")[2];
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 0) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await renderManagePage(db, botToken, cb, chatId, page, "");
}

export const handleManageCallback: CallbackHandler = async ({ db, botToken, cb, parsed }) => {
  if (!hasExactParts(parsed.parts, 3) || parsed.arg !== "page") {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await handleManagePage(db, botToken, cb);
};
