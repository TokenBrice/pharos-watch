import { executeAtomicBatch } from "../lib/db";
import { getCache, setCache } from "../lib/db-cache";
import {
  buildAlertReplyMarkup,
  formatConsolidatedMessage,
  resolveAlertLinkPreviewOptions,
  splitMessage,
} from "../lib/telegram-alerts";
import { buildPendingAlertScope } from "../lib/telegram-pending-provenance";
import { buildDedupeKey } from "./telegram-pending";
import { buildPendingAlertEnqueueStatement } from "./telegram-pending/enqueue";
import { emptyAlerts } from "./dispatch-telegram-routing";
import { loadFreshFreezeAlerts, type FreezeAlert } from "./telegram-alert-freeze";
import { isQuietHoursActive } from "./telegram-quiet-hours";

const FREEZE_CURSOR_KEY = "alert:freeze-tape-cursor";

function isPrivateChat(chatId: string): boolean {
  return Number(chatId) > 0;
}

/**
 * Dedicated immutable freeze-event outbox. It deliberately does not use
 * telegram_alert_target_plans: that legacy table is constrained to five
 * historical families. Each target and its pending outbox row transition from
 * planned to queued in one D1 batch, so a crash can only leave a resumable
 * planned target or a fully queued one.
 */
export async function dispatchFreezeAlertOutbox(db: D1Database, nowSec: number): Promise<{
  state: "stale" | "seeded" | "queued" | "idle";
  observed: number;
  queued: number;
}> {
  const cached = await getCache(db, FREEZE_CURSOR_KEY);
  const cursor = cached && /^\d+$/.test(cached.value) ? Number(cached.value) : null;
  const loaded = await loadFreshFreezeAlerts(db, cursor, nowSec);
  if (loaded.state === "stale") return { state: "stale", observed: 0, queued: 0 };
  if (loaded.state === "unseeded") {
    if (loaded.cursor != null) await setCache(db, FREEZE_CURSOR_KEY, String(loaded.cursor));
    return { state: "seeded", observed: 0, queued: 0 };
  }

  const resumable = await db.prepare(
    `SELECT payload_json FROM telegram_freeze_alert_events
      WHERE status IN ('planning', 'queued') AND expires_at > ?
      ORDER BY detected_at ASC, source_event_id ASC
      LIMIT 32`,
  ).bind(nowSec).all<{ payload_json: string }>();
  const queuedByTapeId = new Map<string, FreezeAlert>();
  for (const row of resumable.results ?? []) {
    try {
      const event = JSON.parse(row.payload_json) as FreezeAlert;
      if (typeof event.tapeEventId === "string" && typeof event.stablecoinId === "string") {
        queuedByTapeId.set(event.tapeEventId, event);
      }
    } catch { /* malformed durable payload remains visible for operator repair */ }
  }
  for (const event of loaded.alerts) queuedByTapeId.set(event.tapeEventId, event);
  let queued = 0;
  for (const event of queuedByTapeId.values()) queued += await persistAndQueueFreezeEvent(db, event, nowSec);
  // Advancing after every event is intentional: each event has its own durable
  // source row and target handoff, so a later event failure resumes from that
  // immutable tape identity rather than replaying a prior one.
  if (loaded.cursor != null) await setCache(db, FREEZE_CURSOR_KEY, String(loaded.cursor));
  return { state: loaded.alerts.length > 0 ? "queued" : "idle", observed: loaded.alerts.length, queued };
}

async function persistAndQueueFreezeEvent(db: D1Database, event: FreezeAlert, nowSec: number): Promise<number> {
  const sourceEventId = `freeze:${event.tapeEventId}`;
  const expiresAt = nowSec + 2 * 60 * 60;
  await db.prepare(
    `INSERT INTO telegram_freeze_alert_events (
       source_event_id, tape_event_id, blacklist_event_id, event_type,
       detected_at, expires_at, payload_json, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)
     ON CONFLICT(tape_event_id) DO NOTHING`,
  ).bind(
    sourceEventId, event.tapeEventId, event.sourceEventId, event.eventType,
    nowSec, expiresAt, JSON.stringify(event), nowSec, nowSec,
  ).run();
  const durableEvent = await db.prepare(
    "SELECT expires_at FROM telegram_freeze_alert_events WHERE source_event_id = ?",
  ).bind(sourceEventId).first<{ expires_at: number }>();
  const durableExpiresAt = Number(durableEvent?.expires_at ?? expiresAt);
  if (durableExpiresAt <= nowSec) {
    await executeAtomicBatch(db, [
      db.prepare("UPDATE telegram_freeze_alert_targets SET status = 'expired' WHERE source_event_id = ? AND status = 'planned'")
        .bind(sourceEventId),
      db.prepare("UPDATE telegram_freeze_alert_events SET status = 'expired', updated_at = ? WHERE source_event_id = ?")
        .bind(nowSec, sourceEventId),
    ]);
    return 0;
  }

  // Capture membership and close the cohort in one transaction. Resumes may
  // queue persisted targets, but subscribers added after this batch cannot join.
  await executeAtomicBatch(db, [
    db.prepare(
      `INSERT INTO telegram_freeze_alert_targets (
         source_event_id, target_key, chat_id, preference_generation,
         pending_dedupe_key, status, created_at
       )
       SELECT ?, ? || ':' || s.chat_id, s.chat_id, s.preference_generation,
              ? || ':' || s.chat_id, 'planned', ?
         FROM telegram_subscribers s
         JOIN telegram_freeze_alert_events event
           ON event.source_event_id = ? AND event.cohort_captured_at IS NULL
         LEFT JOIN telegram_subscriptions sub
           ON sub.chat_id = s.chat_id AND sub.stablecoin_id = ?
        WHERE (s.global_alert_freeze = 1 OR sub.alert_freeze = 1)
          AND (s.alert_snooze_until_ts IS NULL OR s.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)
          AND NOT (COALESCE(sub.alert_freeze, 0) = 0 AND COALESCE(sub.alert_freeze_override, 0) = 1)
       ON CONFLICT(source_event_id, target_key) DO NOTHING`,
    ).bind(
      sourceEventId,
      sourceEventId,
      sourceEventId,
      nowSec,
      sourceEventId,
      event.stablecoinId,
      nowSec,
      nowSec,
    ),
    db.prepare(
      `UPDATE telegram_freeze_alert_events
          SET cohort_captured_at = ?, updated_at = ?
        WHERE source_event_id = ? AND cohort_captured_at IS NULL`,
    ).bind(nowSec, nowSec, sourceEventId),
  ]);

  const targetRows = await db.prepare(
    `SELECT target.target_key, target.chat_id, target.preference_generation,
            s.quiet_hours_enabled, s.quiet_hours_start_utc, s.quiet_hours_end_utc, s.timezone
       FROM telegram_freeze_alert_targets target
       JOIN telegram_subscribers s ON s.chat_id = target.chat_id
      WHERE target.source_event_id = ? AND target.status = 'planned'
      ORDER BY target.target_key ASC
      LIMIT 90`,
  ).bind(sourceEventId).all<{
    target_key: string;
    chat_id: string;
    preference_generation: number;
    quiet_hours_enabled: number | null;
    quiet_hours_start_utc: number | null;
    quiet_hours_end_utc: number | null;
    timezone: string | null;
  }>();

  let queued = 0;
  for (const target of targetRows.results ?? []) {
    const chatId = target.chat_id;
    const alerts = { ...emptyAlerts(), freeze: [event] };
    const html = formatConsolidatedMessage(alerts);
    const scope = buildPendingAlertScope(alerts);
    for (const [chunkIndex, chunk] of splitMessage(html).entries()) {
      const message = {
        chatId,
        html: chunk,
        canonicalHtml: html,
        disableNotification: isQuietHoursActive(
          nowSec,
          Boolean(target.quiet_hours_enabled),
          target.quiet_hours_start_utc,
          target.quiet_hours_end_utc,
          target.timezone,
        ),
        replyMarkup: buildAlertReplyMarkup(alerts, chunkIndex, { privateChat: isPrivateChat(chatId) }),
        chunkIndex,
        alertType: "freeze" as const,
        sourceEventId,
        preferenceGeneration: Number(target.preference_generation),
        alertScope: scope,
        linkPreviewOptions: resolveAlertLinkPreviewOptions(alerts, chunkIndex) ?? undefined,
      };
      const targetKey = buildDedupeKey(message);
      await executeAtomicBatch(db, [
        db.prepare(
          `INSERT INTO telegram_alert_source_events (
             source_event_id, schema_version, status, detected_at, expires_at, event_payload, baseline_payload,
             baseline_committed_at, completed_at
           ) VALUES (?, 1, 'complete', ?, ?, ?, '{}', ?, ?)
           ON CONFLICT(source_event_id) DO NOTHING`,
        ).bind(sourceEventId, nowSec, durableExpiresAt, JSON.stringify({ family: 'freeze', tapeEventId: event.tapeEventId }), nowSec, nowSec),
        db.prepare(
          `INSERT INTO telegram_alert_jobs (
             job_id, alert_type, source_event_id, severity, created_at, expires_at,
             status, target_count, sent_count, enqueued_count, failed_count, metadata
           ) VALUES (?, 'freeze', ?, 'risk', ?, ?, 'discovered', 0, 0, 0, 0, ?)
           ON CONFLICT(job_id) DO NOTHING`,
        ).bind(`telegram:${sourceEventId}:freeze`, sourceEventId, nowSec, durableExpiresAt, JSON.stringify({ source: 'freeze-outbox' })),
        db.prepare(
          `INSERT INTO telegram_alert_job_targets (
             job_id, target_key, chat_id, chunk_index, alert_type, status,
             pending_dedupe_key, created_at, source_event_id
           ) VALUES (?, ?, ?, ?, 'freeze', 'planned', ?, ?, ?)
           ON CONFLICT(job_id, target_key) DO NOTHING`,
        ).bind(`telegram:${sourceEventId}:freeze`, targetKey, chatId, chunkIndex, targetKey, nowSec, sourceEventId),
        db.prepare(
          `INSERT OR IGNORE INTO telegram_alert_job_target_items (
             job_id, target_key, source_event_id, item_key, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ).bind(`telegram:${sourceEventId}:freeze`, targetKey, sourceEventId, `freeze:${event.tapeEventId}`, nowSec),
        buildPendingAlertEnqueueStatement(db, message, nowSec, { ttlSec: durableExpiresAt - nowSec }),
        db.prepare(
          `UPDATE telegram_alert_job_targets
              SET status = 'queued'
            WHERE job_id = ? AND target_key = ? AND status = 'planned'`,
        ).bind(`telegram:${sourceEventId}:freeze`, targetKey),
        db.prepare(
          `UPDATE telegram_freeze_alert_targets
              SET status = 'queued', queued_at = ?, pending_dedupe_key = ?
            WHERE source_event_id = ? AND target_key = ? AND status = 'planned'`,
        ).bind(nowSec, targetKey, sourceEventId, target.target_key),
      ]);
      queued += 1;
    }
  }
  await db.prepare(
    `UPDATE telegram_freeze_alert_events
        SET status = 'queued', updated_at = ?
      WHERE source_event_id = ? AND status = 'planning'`,
  ).bind(nowSec, sourceEventId).run();
  const remaining = await db.prepare(
    "SELECT COUNT(*) AS count FROM telegram_freeze_alert_targets WHERE source_event_id = ? AND status = 'planned'",
  ).bind(sourceEventId).first<{ count: number }>();
  if (Number(remaining?.count ?? 0) === 0) {
    await db.prepare(
      "UPDATE telegram_freeze_alert_events SET status = 'complete', completed_at = ?, updated_at = ? WHERE source_event_id = ?",
    ).bind(nowSec, nowSec, sourceEventId).run();
  }
  await db.prepare(
    `UPDATE telegram_alert_jobs
        SET status = CASE WHEN ? > 0 THEN 'queued' ELSE status END,
            target_count = (
              SELECT COUNT(*) FROM telegram_alert_job_targets WHERE job_id = telegram_alert_jobs.job_id
            ),
            planned_count = (
              SELECT COUNT(*) FROM telegram_alert_job_targets WHERE job_id = telegram_alert_jobs.job_id
            ),
            enqueued_count = (
              SELECT COUNT(*) FROM telegram_alert_job_targets
               WHERE job_id = telegram_alert_jobs.job_id AND status = 'queued'
            )
      WHERE job_id = ?`,
  ).bind(queued, `telegram:${sourceEventId}:freeze`).run();
  return queued;
}
