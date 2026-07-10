import { answerCallbackQuery } from "../../lib/telegram";
import { logTelegramEvent } from "../../lib/telegram-log";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  applySubscribeIntent,
  applyUnsubscribeIntent,
  clearPendingDisambiguation,
  forgetSubscriber,
  loadPendingDisambiguation,
  unixNow,
  unsubscribeAll,
  upsertGlobalAlertTypes,
} from "../telegram-webhook-store";
import { parsePendingDisambiguation } from "../telegram-webhook-parsing";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import type { ConfirmBulkPayload, PendingAction, PendingActionType } from "../telegram-webhook-shared";
import {
  callbackChatType,
  callbackUsername,
  hasExactParts,
  requireAdminForMutatingCallback,
  type CallbackHandler,
  type TelegramCallbackQuery,
} from "./_shared";
import { toErrorMessage } from "../../lib/error-utils";

type ConfirmablePendingAction<T extends PendingActionType> = Extract<PendingAction, { actionType: T }>;

async function loadConfirmablePending<T extends "forget-confirm" | "confirm-bulk">(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  options: {
    actionType: T;
    expiredText: string;
    notPendingText: string;
    cancelActionDetail: string;
  },
  action: "confirm" | "cancel",
): Promise<ConfirmablePendingAction<T> | null> {
  const pendingRow = await loadPendingDisambiguation(db, chatId);

  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    if (pendingRow) {
      await clearPendingDisambiguation(db, chatId);
    }
    await answerCallbackQuery(cb.id, botToken, { text: options.expiredText });
    return null;
  }

  const pendingAction = parsePendingDisambiguation(pendingRow);
  if (!pendingAction || pendingAction.actionType !== options.actionType) {
    await answerCallbackQuery(cb.id, botToken, { text: options.notPendingText });
    return null;
  }

  const actorUserId = cb.from?.id != null ? String(cb.from.id) : null;
  if (pendingAction.initiatorUserId != null && pendingAction.initiatorUserId !== actorUserId) {
    await answerCallbackQuery(cb.id, botToken, {
      text: "Only the user who started this confirmation can complete it.",
    });
    return null;
  }

  if (action === "cancel") {
    await clearPendingDisambiguation(db, chatId);
    await sendAuditedTelegramReply(db, chatId, "Cancelled.", botToken, {
      actionDetail: options.cancelActionDetail,
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Cancelled." });
    return null;
  }

  return pendingAction as ConfirmablePendingAction<T>;
}

async function handleForgetConfirmCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  action: "confirm" | "cancel",
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  const pendingAction = await loadConfirmablePending(db, botToken, cb, chatId, {
    actionType: "forget-confirm",
    expiredText: "This confirmation has expired. Re-run /forget.",
    notPendingText: "No forget confirmation is pending.",
    cancelActionDetail: "callback_forget",
  }, action);
  if (!pendingAction) return;

  try {
    await forgetSubscriber(db, chatId);
  } catch (err) {
    logTelegramEvent({
      message: "forget execution failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "forget-confirm",
      err: toErrorMessage(err),
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Could not delete data. Please try again." });
    return;
  }
  // `forgetSubscriber` already cleared telegram_pending_disambiguation for the
  // chat, so no extra clearPendingDisambiguation call is required here.
  await recordTelegramUsageEvent(db, {
    eventType: "command_forget",
    actionDetail: "command",
    outcome: "success",
  });
  await sendAuditedTelegramReply(
    db,
    chatId,
    "Your subscriber data has been deleted. Use /start to begin again.",
    botToken,
    { actionDetail: "callback_forget", recordReplyOutcome: false },
  );
  await answerCallbackQuery(cb.id, botToken, { text: "Deleted." });
}

async function executeConfirmedBulk(
  db: D1Database,
  chatId: string,
  username: string | null,
  payload: ConfirmBulkPayload,
): Promise<void> {
  if (payload.kind === "subscribe") {
    const alertTypes = new Set(payload.alertTypes);
    if (payload.subscribeAll) {
      await upsertGlobalAlertTypes(db, chatId, username, alertTypes, { clearPending: true });
      await recordTelegramUsageEvent(db, {
        eventType: "subscribe",
        actionDetail: "all",
        outcome: "success",
      });
      await recordTelegramUsageEvent(db, {
        eventType: "global_alert_change",
        actionDetail: "bulk_confirm",
        outcome: "opt_in",
      });
      return;
    }
    await applySubscribeIntent(db, {
      chatId,
      username,
      alertTypes,
      directStablecoinIds: payload.coinIds,
      presetIds: payload.presetIds,
      clearPending: true,
      depegWorseningBpsStep: payload.depegWorseningBpsStep,
    });
    if (payload.presetIds.length > 0) {
      await recordTelegramUsageEvent(db, {
        eventType: "preset_follow",
        actionDetail: "preset",
        outcome: "success",
      });
    }
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: payload.presetIds.length > 0 ? "preset" : "coin",
      outcome: "success",
    });
    return;
  }

  // unsubscribe
  if (payload.unsubscribeAll) {
    await unsubscribeAll(db, chatId, { clearPending: true });
    await recordTelegramUsageEvent(db, {
      eventType: "unsubscribe",
      actionDetail: "all",
      outcome: "success",
    });
    await recordTelegramUsageEvent(db, {
      eventType: "global_alert_change",
      actionDetail: "bulk_confirm",
      outcome: "opt_out",
    });
    return;
  }
  await applyUnsubscribeIntent(db, {
    chatId,
    directStablecoinIds: payload.coinIds,
    presetIds: payload.presetIds,
    clearPending: true,
  });
  if (payload.presetIds.length > 0) {
    await recordTelegramUsageEvent(db, {
      eventType: "preset_unfollow",
      actionDetail: "preset",
      outcome: "success",
    });
  }
  await recordTelegramUsageEvent(db, {
    eventType: "unsubscribe",
    actionDetail: payload.presetIds.length > 0 ? "preset" : "coin",
    outcome: "success",
  });
}

async function handleBulkConfirmCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  action: "confirm" | "cancel",
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  const pendingAction = await loadConfirmablePending(db, botToken, cb, chatId, {
    actionType: "confirm-bulk",
    expiredText: "This confirmation has expired. Re-run the command.",
    notPendingText: "No bulk confirmation is pending.",
    cancelActionDetail: "callback_bulk",
  }, action);
  if (!pendingAction) return;

  // The confirmed state change and pending-row clear commit in one store batch.
  const username = callbackUsername(cb);
  try {
    await executeConfirmedBulk(db, chatId, username, pendingAction.payload);
  } catch (err) {
    logTelegramEvent({
      message: "bulk confirm execution failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "confirm-bulk",
      err: toErrorMessage(err),
    });
    await answerCallbackQuery(cb.id, botToken, { text: "Could not apply changes. Please try again." });
    return;
  }
  await sendAuditedTelegramReply(db, chatId, "Confirmed.", botToken, {
    actionDetail: "callback_bulk",
  });
  await answerCallbackQuery(cb.id, botToken, { text: "Applied." });
}

/**
 * Routes `confirm:bulk` / `confirm:forget` (and `cancel:bulk` / `cancel:forget`)
 * to the right confirmation state machine. Registered under both `confirm` and
 * `cancel` actions in `CALLBACK_HANDLERS` since the dispatch logic is identical.
 */
export const handleBulkActionCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  if (
    (parsed.action !== "confirm" && parsed.action !== "cancel") ||
    !hasExactParts(parsed.parts, 2) ||
    (parsed.arg !== "bulk" && parsed.arg !== "forget")
  ) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  if (parsed.arg === "forget") {
    // /forget is private-chat-only; the command handler enforces that on the
    // outgoing side, but defend in depth in case the keyboard leaks elsewhere.
    if (callbackChatType(cb) !== "private") {
      await answerCallbackQuery(cb.id, botToken, { text: "Open a private chat with PharosWatchBot." });
      return;
    }
    await handleForgetConfirmCallback(db, botToken, cb, parsed.action);
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) {
    return;
  }
  await handleBulkConfirmCallback(db, botToken, cb, parsed.action);
};
