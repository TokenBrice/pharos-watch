import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { answerCallbackQuery } from "../../lib/telegram";
import { logTelegramEvent } from "../../lib/telegram-log";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { removeSubscriptions } from "../telegram-webhook-store";
import { loadChatSubscriptions, renderManageWatchlistPage } from "./manage";
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
  let prev: number | null = null;
  let next: number | null = null;
  for (const row of rows) {
    for (const button of row) {
      const data = button.callback_data;
      if (!data || !data.startsWith("manage:page:")) continue;
      const pageNum = Number(data.split(":")[2]);
      if (!Number.isFinite(pageNum)) continue;
      if (button.text?.includes("Prev")) prev = pageNum;
      else if (button.text?.includes("Next")) next = pageNum;
    }
  }
  if (prev != null) return prev + 1;
  if (next != null) return next - 1;
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
  const chatType = callbackChatType(cb);
  const isGroup = chatType === "group" || chatType === "supergroup";
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
      chatId,
      userId: cb.from?.id ?? null,
      action: "unsub",
      err: err instanceof Error ? err.message : String(err),
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

  const subscriptions = await loadChatSubscriptions(db, chatId);
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
