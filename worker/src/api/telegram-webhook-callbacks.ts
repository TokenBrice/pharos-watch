/**
 * callback_query router for inline-keyboard taps.
 *
 * Data format: `action:arg` (≤64 bytes per the Bot API limit).
 * Currently supported:
 *   - `snooze:1h | 4h | 24h` — sets alert_snooze_until_ts on telegram_subscribers
 *
 * Unknown action codes receive a silent ack so the bot stays forward-compatible
 * with future keyboard changes.
 */

import { answerCallbackQuery } from "../lib/telegram";
import { unixNow, upsertSubscriberRow } from "./telegram-webhook-store";

const SNOOZE_SECONDS: Record<string, number> = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
};

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { username?: string };
  message?: { chat?: { id?: number }; message_id?: number };
}

export async function handleCallbackQuery(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  const data = cb.data ?? "";
  const username = cb.from?.username ?? null;
  const [action, arg] = data.split(":");

  if (action === "snooze" && arg && Object.prototype.hasOwnProperty.call(SNOOZE_SECONDS, arg)) {
    const now = unixNow();
    const until = now + SNOOZE_SECONDS[arg];
    // Ensure a subscriber row exists first so the UPDATE below has a target.
    await upsertSubscriberRow(db, { chatId, username, nowSec: now });
    await db
      .prepare(
        "UPDATE telegram_subscribers SET alert_snooze_until_ts = ?, last_active_at = ? WHERE chat_id = ?",
      )
      .bind(until, now, chatId)
      .run();
    await answerCallbackQuery(cb.id, botToken, {
      text: `Snoozed for ${arg}. Use /list to verify or tap a longer window.`,
    });
    return;
  }

  await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
}
