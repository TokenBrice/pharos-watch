import { sendToChat, type SendToChatOpts } from "../lib/telegram";
import { logTelegramEvent } from "../lib/telegram-log";
import {
  recordTelegramReplyOutcome,
  recordTelegramUsageEvent,
} from "../lib/telegram-usage-analytics";
import { splitMessage } from "../lib/telegram-alerts";

export interface AuditedTelegramReplyOptions extends SendToChatOpts {
  actionDetail?: string;
}

/**
 * Shared send helper for user-visible webhook replies. Command replies update
 * reply diagnostics only; alert delivery diagnostics are owned by the delivery
 * cron senders.
 */
export async function sendAuditedTelegramReply(
  db: D1Database,
  chatId: string,
  message: string,
  botToken: string,
  options: AuditedTelegramReplyOptions = {},
): Promise<void> {
  const {
    actionDetail = "reply",
    replyMarkup,
    ...sendOptions
  } = options;
  const chunks = splitMessage(message);
  let ok = true;
  let errorClass: string | null = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const isLastChunk = i === chunks.length - 1;
    const result = await sendToChat(chatId, chunks[i], botToken, {
      disableWebPagePreview: true,
      ...sendOptions,
      ...(isLastChunk && replyMarkup != null ? { replyMarkup } : {}),
    });
    if (!result.ok) {
      ok = false;
      errorClass = result.errorClass ?? "unknown";
      await recordTelegramUsageEvent(db, {
        eventType: "reply_failure",
        actionDetail,
        outcome: "failed",
        failureClass: errorClass,
      });
      logTelegramEvent({
        level: "warn",
        message: "reply send failed",
        chatId,
        action: actionDetail,
        errorClass,
        statusCode: result.statusCode,
      });
      if (result.errorClass === "rate_limit" || !result.retryable) break;
    }
  }
  await recordTelegramReplyOutcome(db, { chatId, ok, errorClass });
}
