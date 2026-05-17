import { buildSubscriberUpsert, unixNow } from "./subscribers";

/**
 * Replace the subscriber's IANA timezone (used to interpret quiet hours
 * locally). `timezone = null` clears any prior value, reverting the chat to
 * UTC. Routes through the single `buildSubscriberUpsert` builder so the
 * 15-column INSERT shape stays in lock-step with the rest of the file.
 */
export async function setSubscriberTimezone(
  db: D1Database,
  chatId: string,
  username: string | null,
  timezone: string | null,
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    timezone,
  });
  await db.prepare(sql).bind(...binds).run();
}

/**
 * Apply a chat-wide alert snooze. Mirrors the inline SQL the snooze callback
 * (`telegram-webhook-callbacks.ts:367-385`) writes today; routed through the
 * store so the Mini App `set-snooze` mutation stays seam-compliant.
 */
export async function setSubscriberSnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
  untilSec: number,
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    alertSnoozeUntilTs: untilSec,
  });
  await db.prepare(sql).bind(...binds).run();
}

/**
 * Apply a per-coin snooze (or clear it). Mirrors the inline SQL the
 * `coinsnooze:` callback (`telegram-webhook-callbacks.ts:434-449`) writes today.
 * Inserts a zero-flagged subscription row when none exists so the dispatcher
 * filter for `alert_snooze_until_ts` takes effect on global fan-out as well.
 */
export async function setSubscriptionSnooze(
  db: D1Database,
  chatId: string,
  stablecoinId: string,
  untilSec: number | null,
): Promise<void> {
  const now = unixNow();
  await db.batch([
    db
      .prepare(
        `INSERT INTO telegram_subscriptions (
           chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch,
           alert_snooze_until_ts
         )
         VALUES (?, ?, 0, 0, 0, 0, ?)
         ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
           alert_snooze_until_ts = excluded.alert_snooze_until_ts`,
      )
      .bind(chatId, stablecoinId, untilSec),
    db
      .prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?")
      .bind(now, chatId),
  ]);
}

export async function clearAlertSnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    alertSnoozeUntilTs: null,
  });
  await db.prepare(sql).bind(...binds).run();
}
