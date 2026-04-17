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
import { unixNow } from "./telegram-webhook-store";

const SNOOZE_SECONDS = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
} as const;

type SnoozeArg = keyof typeof SNOOZE_SECONDS;

function isSnoozeArg(arg: string | undefined): arg is SnoozeArg {
  return arg === "1h" || arg === "4h" || arg === "24h";
}

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

  const [action, arg] = (cb.data ?? "").split(":");

  if (action === "snooze" && isSnoozeArg(arg)) {
    const now = unixNow();
    const until = now + SNOOZE_SECONDS[arg];
    const username = cb.from?.username ?? null;

    // Single INSERT ... ON CONFLICT: stamps the snooze column on both new rows
    // and existing rows, collapsing what used to be an upsert + UPDATE pair.
    // DB write and ack run concurrently since they address different services.
    await Promise.all([
      db
        .prepare(
          `INSERT INTO telegram_subscribers (
             chat_id, username,
             alert_dews, alert_depeg, alert_safety, alert_launch,
             global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
             quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
             alert_snooze_until_ts,
             created_at, last_active_at
           )
           VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             username = COALESCE(excluded.username, telegram_subscribers.username),
             alert_snooze_until_ts = excluded.alert_snooze_until_ts,
             last_active_at = excluded.last_active_at`,
        )
        .bind(chatId, username, until, now, now)
        .run(),
      answerCallbackQuery(cb.id, botToken, {
        text: `Snoozed for ${arg}. Use /list to verify or tap a longer window.`,
      }),
    ]);
    return;
  }

  await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
}
