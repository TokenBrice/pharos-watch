import {
  buildSubscriberUpsert,
  preparePreferenceGenerationBump,
  unixNow,
} from "./subscribers";
import { assertSubscribableCoin } from "../../lib/telegram-subscription-eligibility";
import { executeAtomicBatch } from "../../lib/db";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "../../lib/telegram-operation-batch";
import { nextIanaLocalHourDueAt } from "@shared/lib/iana-local-time";

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
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  const nowSec = unixNow();
  const recap = await db.prepare(
    `SELECT enabled, delivery_hour_local
       FROM telegram_recap_preferences
      WHERE chat_id = ? AND chat_kind = 'private'`,
  ).bind(chatId).first<{ enabled: number; delivery_hour_local: number }>();
  const recapEnabled = recap?.enabled === 1;
  const nextDueAt = recapEnabled && timezone != null
    ? nextIanaLocalHourDueAt(nowSec * 1000, timezone, recap.delivery_hour_local)
    : null;
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec,
    timezone,
  });
  const statements: D1PreparedStatement[] = [db.prepare(sql).bind(...binds)];
  if (recapEnabled) {
    if (nextDueAt != null) {
      statements.push(db.prepare(`
        UPDATE telegram_recap_preferences
           SET next_due_at = ?, updated_at = ?
         WHERE chat_id = ? AND enabled = 1 AND chat_kind = 'private'
      `).bind(Math.floor(nextDueAt / 1000), nowSec, chatId));
    } else {
      // A cleared zone can no longer meet the explicit-timezone contract. Do
      // not leave a logically enabled recap stranded without a schedule.
      statements.push(
        db.prepare(`
          UPDATE telegram_recap_preferences
             SET enabled = 0, next_due_at = NULL, updated_at = ?
           WHERE chat_id = ? AND enabled = 1 AND chat_kind = 'private'
        `).bind(nowSec, chatId),
        db.prepare(`
          UPDATE telegram_recap_targets
             SET status = 'cancelled', terminal_reason = 'timezone_cleared',
                 completed_at = ?, updated_at = ?
           WHERE chat_id = ? AND status IN ('planned', 'queued')
        `).bind(nowSec, nowSec, chatId),
        db.prepare(`
          DELETE FROM telegram_pending_alerts
           WHERE chat_id = ? AND source_type = 'personalized_recap'
             AND source_event_id IN (
               SELECT recap_key FROM telegram_recap_targets
                WHERE chat_id = ? AND status = 'cancelled'
             )
        `).bind(chatId, chatId),
      );
    }
  }
  await executeAtomicBatch(
    db,
    appendTelegramOperationStatements(statements, options),
  );
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
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    alertSnoozeUntilTs: untilSec,
  });
  await executeAtomicBatch(
    db,
    appendTelegramOperationStatements([db.prepare(sql).bind(...binds)], options),
  );
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
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  if (untilSec === null) {
    await executeAtomicBatch(db, appendTelegramOperationStatements([
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
              AND alert_freeze = 0
              AND alert_dews_override = 0
              AND alert_depeg_override = 0
              AND alert_safety_override = 0
              AND alert_launch_override = 0
              AND alert_reserve_override = 0
              AND alert_freeze_override = 0
              AND dews_min_band IS NULL
              AND safety_mode IS NULL
              AND depeg_worsening_bps_step IS NULL`,
        )
        .bind(chatId, stablecoinId),
      preparePreferenceGenerationBump(db, chatId),
    ], options));
    return;
  }

  assertSubscribableCoin(stablecoinId);
  const now = unixNow();
  const parentUpsert = buildSubscriberUpsert({
    kind: "bump",
    chatId,
    username: null,
    nowSec: now,
    bumpPreferenceGeneration: true,
  });
  await executeAtomicBatch(db, appendTelegramOperationStatements([
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
  ], options));
}

export async function clearAlertSnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  const { sql, binds } = buildSubscriberUpsert({
    kind: "preference",
    chatId,
    username,
    nowSec: unixNow(),
    alertSnoozeUntilTs: null,
  });
  await executeAtomicBatch(
    db,
    appendTelegramOperationStatements([db.prepare(sql).bind(...binds)], options),
  );
}
