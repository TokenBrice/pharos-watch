import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { answerCallbackQuery } from "../../lib/telegram";
import { logTelegramEvent } from "../../lib/telegram-log";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { loadSubscriptionRowsByChat, removeSubscriptions } from "../telegram-webhook-store";
import { isGroupChatType } from "../telegram-webhook-auth";
import { renderManageWatchlistPage } from "./manage";
import {
  callbackChatType,
  hasExactParts,
  isKnownStablecoinId,
  requireAdminForMutatingCallback,
  type CallbackHandler,
  type TelegramCallbackQuery,
} from "./_shared";

// Best-effort: scan the current message's inline keyboard for the latest
// `manage:page:N` callback (Prev/Next buttons) and infer the active page. The
// active page sits between Prev (N-1) and Next (N+1) when both are present;
// at the edges only one nav button exists. Returns 0 when the message has no
// nav row (single-page state).
function inferCurrentManagePage(cb: TelegramCallbackQuery): number {
  const message = cb.message as
    | { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>> } }
    | undefined;
  const rows = message?.reply_markup?.inline_keyboard ?? [];
  const navPages: Array<{ page: number; text: string }> = [];
  for (const row of rows) {
    for (const button of row) {
      const data = button.callback_data;
      if (!data || !data.startsWith("manage:page:")) continue;
      const pageNum = Number(data.split(":")[2]);
      if (!Number.isInteger(pageNum) || pageNum < 0) continue;
      navPages.push({ page: pageNum, text: button.text ?? "" });
    }
  }
  if (navPages.length >= 2) {
    const sorted = [...navPages].sort((a, b) => a.page - b.page);
    const min = sorted[0]?.page;
    const max = sorted[sorted.length - 1]?.page;
    if (min != null && max != null && max - min === 2) return min + 1;
  }
  const single = navPages[0];
  if (single) {
    if (single.text.includes("Prev")) return single.page + 1;
    if (single.text.includes("Next")) return Math.max(0, single.page - 1);
  }
  return 0;
}

async function handleManageUnsub(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  stablecoinId: string,
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  // Apply the same admin gate used by /unsubscribe so a single group member
  // cannot remove subscriptions out from under the rest of the chat.
  const isGroup = isGroupChatType(callbackChatType(cb));
  if (
    isGroup &&
    !(await requireAdminForMutatingCallback(
      db,
      botToken,
      cb,
      chatId,
      "Only group admins can unsubscribe.",
    ))
  ) {
    return;
  }

  // Determine the current page from the callback message keyboard so we can
  // re-render at the same page after deletion. Fall back to page 0 if we
  // cannot infer it (e.g. message context missing).
  const currentPage = inferCurrentManagePage(cb);

  try {
    await removeSubscriptions(db, chatId, [stablecoinId]);
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "callback_unsub",
      outcome: "success",
    });
  } catch (err) {
    logTelegramEvent({
      message: "unsub callback write failed",
      action: "unsub",
    });
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "callback_unsub",
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not remove subscription. Please try again.",
    });
    return;
  }

  const subscriptions = await loadSubscriptionRowsByChat(db, chatId);
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const ackText = `Removed ${meta?.symbol ?? stablecoinId}.`;
  await renderManageWatchlistPage(db, botToken, cb, {
    chatId,
    subscriptions,
    requestedPage: currentPage,
    ackText,
  });
}

export const handleUnsubCallback: CallbackHandler = async ({ db, botToken, cb, parsed }) => {
  if (!hasExactParts(parsed.parts, 2) || !isKnownStablecoinId(parsed.arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await handleManageUnsub(db, botToken, cb, parsed.arg);
};
