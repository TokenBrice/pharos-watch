import { buildSubscriberUpsert, unixNow } from "./subscribers";
import { assertSubscribableCoin } from "../../lib/telegram-subscription-eligibility";

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
 * Apply a per-coin snooze (or clear it). Setting a snooze creates a zero-flagged
 * row when needed so global fan-out is suppressed too. Clearing is update-only:
 * it removes a snooze-only row, but preserves alerts, tuning, and explicit-off
 * markers that continue to carry subscription intent.
 */
export async function setSubscriptionSnooze(
  db: D1Database,
  chatId: string,
  stablecoinId: string,
  untilSec: number | null,
): Promise<void> {
  if (untilSec === null) {
    await db.batch([
      db
        .prepare(
          `UPDATE telegram_subscriptions
              SET alert_snooze_until_ts = NULL
            WHERE chat_id = ? AND stablecoin_id = ?`,
        )
        .bind(chatId, stablecoinId),
      db
        .prepare(
          `DELETE FROM telegram_subscriptions
            WHERE chat_id = ?
              AND stablecoin_id = ?
              AND alert_snooze_until_ts IS NULL
              AND alert_dews = 0
              AND alert_depeg = 0
              AND alert_safety = 0
              AND alert_launch = 0
              AND alert_reserve = 0
              AND alert_dews_override = 0
              AND alert_depeg_override = 0
              AND alert_safety_override = 0
              AND alert_launch_override = 0
              AND alert_reserve_override = 0
              AND dews_min_band IS NULL
              AND safety_mode IS NULL
              AND depeg_worsening_bps_step IS NULL`,
        )
        .bind(chatId, stablecoinId),
    ]);
    return;
  }

  assertSubscribableCoin(stablecoinId);
  const now = unixNow();
  const parentUpsert = buildSubscriberUpsert({
    kind: "bump",
    chatId,
    username: null,
    nowSec: now,
  });
  await db.batch([
    db.prepare(parentUpsert.sql).bind(...parentUpsert.binds),
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
