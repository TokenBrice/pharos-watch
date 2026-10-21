import {
  ACTIVE_PRESET_FLAGS_SQL,
  ACTIVE_SUBSCRIPTION_FLAGS_SQL,
  TELEGRAM_ALERT_PERSISTENCE,
} from "@shared/lib/telegram-alert-families";
import { splitMessage } from "../common/alerts-formatting";
import type { TelegramDeliveryInput } from "./jobs";

export type TelegramBroadcastScope =
  | "all"
  | "deliverable-watchers"
  | "global-subscribers"
  | "retired-launch-opt-ins";

export async function loadBroadcastTargetChatIds(
  db: D1Database,
  scope: TelegramBroadcastScope,
  page?: { afterChatId: string | null; limit: number },
): Promise<string[]> {
  const globalPredicate = Object.values(TELEGRAM_ALERT_PERSISTENCE)
    .map((spec) => `s.${spec.globalColumn} = 1`)
    .join(" OR ");
  const globalSubscriberPredicate = Object.values(TELEGRAM_ALERT_PERSISTENCE)
    .map((spec) => `${spec.globalColumn} = 1`)
    .join(" OR ");

  // One-time retirement notice audience: chats that still carry a launch
  // opt-in (global or per-coin). The retired columns are read only here.
  const sql = scope === "retired-launch-opt-ins"
    ? `SELECT s.chat_id
         FROM telegram_subscribers s
        WHERE s.${TELEGRAM_ALERT_PERSISTENCE.launch.globalColumn} = 1
           OR EXISTS (
             SELECT 1 FROM telegram_subscriptions
              WHERE chat_id = s.chat_id
                AND ${TELEGRAM_ALERT_PERSISTENCE.launch.subscriptionColumn} = 1
           )
        ORDER BY s.chat_id`
    : scope === "global-subscribers"
    ? `SELECT chat_id FROM telegram_subscribers
        WHERE ${globalSubscriberPredicate}
        ORDER BY chat_id`
    : scope === "deliverable-watchers"
      ? `SELECT s.chat_id
           FROM telegram_subscribers s
          WHERE ${globalPredicate}
             OR EXISTS (
               SELECT 1 FROM telegram_subscriptions
                WHERE chat_id = s.chat_id
                  AND (${ACTIVE_SUBSCRIPTION_FLAGS_SQL})
             )
             OR EXISTS (
               SELECT 1 FROM telegram_preset_subscriptions
                WHERE chat_id = s.chat_id
                  AND (${ACTIVE_PRESET_FLAGS_SQL})
             )
          ORDER BY s.chat_id`
      : `SELECT chat_id FROM telegram_subscribers ORDER BY chat_id`;
  // SAFETY: `sql` is one of the fixed scope queries above; page bounds are bound.
  const rows = page
    ? await db.prepare(`SELECT chat_id FROM (${sql}) WHERE chat_id > ? ORDER BY chat_id LIMIT ?`)
      .bind(page.afterChatId ?? "", page.limit + 1).all<{ chat_id: string }>()
    : await db.prepare(sql).all<{ chat_id: string }>();
  return (rows.results ?? []).map((row) => row.chat_id);
}

export interface TelegramBroadcastJobPayload {
  messageHtml: string;
  scope: TelegramBroadcastScope;
  /** The canary chat already received the message synchronously. */
  excludeChatId?: string;
}

/**
 * One fan-out page of an admin broadcast job: the scope's chats after the
 * cursor, every chunk of the message, notice audience (no snooze/quiet-hours
 * gate, no duplicate suppression).
 */
export async function buildBroadcastJobPage(ctx: {
  db: D1Database;
  payload: TelegramBroadcastJobPayload;
  cursor: string | null;
  limit: number;
}): Promise<{ deliveries: TelegramDeliveryInput[]; nextCursor: string | null }> {
  // One extra row tells whether another page follows.
  const after = await loadBroadcastTargetChatIds(ctx.db, ctx.payload.scope, {
    afterChatId: ctx.cursor,
    limit: ctx.limit,
  });
  const page = after.slice(0, ctx.limit);
  const chunks = splitMessage(ctx.payload.messageHtml);
  const deliveries = page
    .filter((chatId) => chatId !== ctx.payload.excludeChatId)
    .flatMap((chatId) => chunks.map((chunk, seq): TelegramDeliveryInput => ({
      chatId,
      seq,
      body: chunk,
      disableWebPagePreview: true,
      audience: "notice",
      families: ["adminBroadcast"],
    })));
  return {
    deliveries,
    nextCursor: after.length > ctx.limit ? page[page.length - 1]! : null,
  };
}
