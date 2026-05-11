import { sendToChat, type BatchMessage, type TelegramSendErrorClass } from "../lib/telegram";
import { batchExecute } from "../lib/db";
import { SNOOZE_REPLY_MARKUP, TELEGRAM_SPLIT_VERSION } from "../lib/telegram-alerts";
import { isQuietHoursActive } from "./telegram-quiet-hours";

// ---------- Constants ----------

export const PENDING_TTL_SEC = 3600; // 1 hour — stale alerts are worse than no alert
export const SEND_BATCH_SIZE = 4; // Parallel sends per batch (leave Workers connection headroom)
/** Defensive ceiling so a pathological row cannot loop forever inside the TTL window. */
export const PENDING_MAX_ATTEMPTS = 20;
/**
 * Exponential backoff schedule (seconds) indexed by prior attempt count, capped at 600s.
 * Used when Telegram does not return a Retry-After header. Step 0 (no prior attempts) is
 * unused in practice because the row only enters the schedule after the first failure.
 */
export const PENDING_BACKOFF_SCHEDULE_SEC = [60, 120, 240, 480, 600] as const;
const PENDING_BACKOFF_CAP_SEC = PENDING_BACKOFF_SCHEDULE_SEC[PENDING_BACKOFF_SCHEDULE_SEC.length - 1];

// ---------- Types ----------

export interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  attempts: number;
  not_before_at: number | null;
  alert_snooze_until_ts: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
}

export interface PendingDrainResult {
  attempted: number;
  sent: number;
  blocked: number;
  blockedCleanupFailed: number;
  retryQueued: number;
  dropped: number;
  /** Drained rows dropped because Telegram returned a non-retryable, non-blocked error. */
  droppedPermanentFailure: number;
  /** Drained rows dropped because the defensive attempts ceiling was hit inside the TTL window. */
  droppedMaxAttemptsFallback: number;
  deferred: number;
  rateLimited: boolean;
  retryAfterSec: number | null;
  notBeforeAt: number | null;
}

export interface PendingEnqueueOptions {
  notBeforeAt?: number | null;
  lastErrorClass?: TelegramSendErrorClass | null;
  retryAfterSec?: number | null;
}

const DEFAULT_RETRY_DELAY_SEC = PENDING_BACKOFF_SCHEDULE_SEC[0];

// Two-strike rule: a single 403 is transient (user temporarily muted bot,
// chat archived, etc.). Only after a second 403 within this window do we
// zero all alert flags. Successful sends reset the counter to 0.
export const BLOCK_STRIKE_WINDOW_SEC = 24 * 3600;

function emptyDrainResult(): PendingDrainResult {
  return {
    attempted: 0,
    sent: 0,
    blocked: 0,
    blockedCleanupFailed: 0,
    retryQueued: 0,
    dropped: 0,
    droppedPermanentFailure: 0,
    droppedMaxAttemptsFallback: 0,
    deferred: 0,
    rateLimited: false,
    retryAfterSec: null,
    notBeforeAt: null,
  };
}

/**
 * Backoff seconds for the *next* attempt given the prior attempt count.
 * Honors Telegram's `Retry-After` when provided; otherwise indexes into
 * `PENDING_BACKOFF_SCHEDULE_SEC` and caps at the schedule's last value.
 */
export function pendingBackoffSec(priorAttempts: number, retryAfterSec: number | null): number {
  if (retryAfterSec != null && retryAfterSec > 0) return retryAfterSec;
  const idx = Math.min(Math.max(priorAttempts, 0), PENDING_BACKOFF_SCHEDULE_SEC.length - 1);
  return PENDING_BACKOFF_SCHEDULE_SEC[idx] ?? PENDING_BACKOFF_CAP_SEC;
}

function isPendingRowSnoozed(row: PendingAlertRow, nowSec: number): boolean {
  return row.alert_snooze_until_ts != null && row.alert_snooze_until_ts > nowSec;
}

function shouldSilencePendingRow(row: PendingAlertRow, nowSec: number): boolean {
  return row.disable_notification === 1 || isQuietHoursActive(
    nowSec,
    Boolean(row.quiet_hours_enabled),
    row.quiet_hours_start_utc,
    row.quiet_hours_end_utc,
  );
}

function pendingRetryDelaySec(priorAttempts: number, retryAfterSec: number | null): number {
  return pendingBackoffSec(priorAttempts, retryAfterSec);
}

function hashDedupePart(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Build a stable dedupe key for the pending queue.
 *
 * The hash covers the PRE-split canonical message body (falling back to the
 * chunk HTML only when callers have not plumbed `canonicalHtml` through, e.g.
 * legacy or test paths), tagged with {@link TELEGRAM_SPLIT_VERSION} so any
 * future change to the chunking algorithm cleanly invalidates old rows rather
 * than orphaning them. The chunk index keeps split parts distinct.
 */
export function buildDedupeKey(message: BatchMessage, splitVersion: number = TELEGRAM_SPLIT_VERSION): string {
  const canonical = message.canonicalHtml ?? message.html;
  return `${message.chatId}:v${splitVersion}:${message.chunkIndex ?? 0}:${hashDedupePart(canonical)}`;
}

// ---------- Subscriber Lifecycle ----------

/**
 * Two-strike gate for 403 responses. Increments the per-subscriber consecutive
 * block counter and reports whether the aggressive cascade should run.
 *
 * Rules:
 * - First strike: record `consecutive_block_first_at = nowSec`, count = 1, return false.
 * - Subsequent strike within `BLOCK_STRIKE_WINDOW_SEC` of first strike: count >= 2, return true.
 * - Stale first strike (older than window): reset to fresh first strike, return false.
 *
 * On D1 error this returns false so we never call `disableBlockedSubscriber`
 * with stale strike state.
 */
export async function registerSubscriberBlockAndShouldDisable(
  db: D1Database,
  chatId: string,
  nowSec: number,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT consecutive_block_count, consecutive_block_first_at
           FROM telegram_subscribers
          WHERE chat_id = ?`,
      )
      .bind(chatId)
      .first<{ consecutive_block_count: number | null; consecutive_block_first_at: number | null }>();
    const priorCount = row?.consecutive_block_count ?? 0;
    const priorFirstAt = row?.consecutive_block_first_at ?? null;
    const withinWindow = priorFirstAt != null && nowSec - priorFirstAt <= BLOCK_STRIKE_WINDOW_SEC;
    const nextCount = withinWindow ? priorCount + 1 : 1;
    const nextFirstAt = withinWindow ? priorFirstAt : nowSec;
    await db
      .prepare(
        `UPDATE telegram_subscribers
            SET consecutive_block_count = ?,
                consecutive_block_first_at = ?
          WHERE chat_id = ?`,
      )
      .bind(nextCount, nextFirstAt, chatId)
      .run();
    return nextCount >= 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-pending-queue] Failed to register block strike for ${chatId}: ${message}`);
    return false;
  }
}

/** Reset the consecutive-block counter on any successful send. */
export async function resetSubscriberBlockCount(db: D1Database, chatId: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE telegram_subscribers
            SET consecutive_block_count = 0,
                consecutive_block_first_at = NULL
          WHERE chat_id = ?
            AND (consecutive_block_count <> 0 OR consecutive_block_first_at IS NOT NULL)`,
      )
      .bind(chatId)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-pending-queue] Failed to reset block count for ${chatId}: ${message}`);
  }
}

export async function disableBlockedSubscriber(db: D1Database, chatId: string): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE telegram_subscribers
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0,
                  global_alert_dews=0,
                  global_alert_depeg=0,
                  global_alert_safety=0,
                  global_alert_launch=0,
                  global_depeg_worsening_bps_step=NULL
            WHERE chat_id=?`,
        )
        .bind(chatId),
      db
        .prepare(
          `UPDATE telegram_subscriptions
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
    ]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-pending-queue] Failed to disable blocked subscriber ${chatId}: ${message}`);
    return false;
  }
}

// ---------- Pending Queue Operations ----------

export async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PendingDrainResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - PENDING_TTL_SEC;
  const rows = await db
    .prepare(
      `SELECT p.id, p.chat_id, p.message_html, p.disable_notification, p.created_at, p.attempts,
              p.not_before_at, u.alert_snooze_until_ts, u.quiet_hours_enabled,
              u.quiet_hours_start_utc, u.quiet_hours_end_utc
         FROM telegram_pending_alerts p
         LEFT JOIN telegram_subscribers u ON u.chat_id = p.chat_id
        WHERE p.created_at >= ?
          AND (p.not_before_at IS NULL OR p.not_before_at <= ?)
        ORDER BY COALESCE(p.not_before_at, p.created_at) ASC, p.created_at ASC
        LIMIT ?`,
    )
    .bind(cutoff, nowSec, limit)
    .all<PendingAlertRow>();

  const pending = rows.results ?? [];
  if (pending.length === 0) {
    return emptyDrainResult();
  }

  let attempted = 0;
  let sent = 0;
  let blocked = 0;
  let blockedCleanupFailed = 0;
  let retryQueued = 0;
  let dropped = 0;
  let droppedPermanentFailure = 0;
  let droppedMaxAttemptsFallback = 0;
  let deferred = 0;
  const idsToDelete: number[] = [];
  const retryUpdates: Array<{ id: number; priorAttempts: number; retryAfterSec: number | null; errorClass: TelegramSendErrorClass | null }> = [];
  const deferUpdates: Array<{ id: number; notBeforeAt: number }> = [];
  let rateLimited = false;
  let rateLimitRetryAfterSec: number | null = null;
  let rateLimitNotBeforeAt: number | null = null;

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted || rateLimited) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE).filter((row) => {
      if (!isPendingRowSnoozed(row, nowSec)) return true;
      deferred++;
      deferUpdates.push({ id: row.id, notBeforeAt: Math.max(row.alert_snooze_until_ts ?? 0, nowSec + DEFAULT_RETRY_DELAY_SEC) });
      return false;
    });
    if (batch.length === 0) continue;
    const results = await Promise.all(
      batch.map(async (row) => {
        const result = await sendToChat(row.chat_id, row.message_html, botToken, {
          disableWebPagePreview: true,
          disableNotification: shouldSilencePendingRow(row, nowSec),
          replyMarkup: SNOOZE_REPLY_MARKUP,
          signal,
        });
        return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ...result };
      }),
    );

    const chatsResetThisLoop = new Set<string>();
    for (const result of results) {
      attempted++;
      if (result.ok) {
        sent++;
        idsToDelete.push(result.id);
        if (!chatsResetThisLoop.has(result.chatId)) {
          chatsResetThisLoop.add(result.chatId);
          await resetSubscriberBlockCount(db, result.chatId);
        }
      } else if (result.blocked) {
        blocked++;
        idsToDelete.push(result.id);
        const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, result.chatId, nowSec);
        if (shouldDisable && !(await disableBlockedSubscriber(db, result.chatId))) {
          blockedCleanupFailed++;
        }
      } else if (result.retryable && result.attempts < PENDING_MAX_ATTEMPTS) {
        // Age-based retry: keep retrying inside the TTL window (enforced at SELECT time).
        // The defensive PENDING_MAX_ATTEMPTS ceiling prevents a pathological row from looping
        // forever with sub-second backoffs.
        retryQueued++;
        retryUpdates.push({
          id: result.id,
          priorAttempts: result.attempts,
          retryAfterSec: result.retryAfterSec,
          errorClass: result.errorClass,
        });
        if (result.errorClass === "rate_limit") {
          rateLimited = true;
          rateLimitRetryAfterSec = result.retryAfterSec;
          rateLimitNotBeforeAt = nowSec + pendingRetryDelaySec(result.attempts, result.retryAfterSec);
        }
      } else if (result.retryable) {
        // Hit the defensive attempts ceiling while still retryable.
        dropped++;
        droppedMaxAttemptsFallback++;
        idsToDelete.push(result.id);
      } else {
        // Non-retryable, non-blocked: classify as permanent failure (e.g. 400 bad_request, 401 auth_error).
        dropped++;
        droppedPermanentFailure++;
        idsToDelete.push(result.id);
      }
    }
  }

  if (idsToDelete.length > 0) {
    const placeholders = idsToDelete.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM telegram_pending_alerts WHERE id IN (${placeholders})`)
      .bind(...idsToDelete)
      .run();
  }

  if (deferUpdates.length > 0) {
    await batchExecute(db, deferUpdates.map((update) =>
      db
        .prepare("UPDATE telegram_pending_alerts SET not_before_at = ?, updated_at = ? WHERE id = ?")
        .bind(update.notBeforeAt, nowSec, update.id),
    ));
  }

  if (retryUpdates.length > 0) {
    await batchExecute(db, retryUpdates.map((update) => {
      const notBeforeAt = nowSec + pendingRetryDelaySec(update.priorAttempts, update.retryAfterSec);
      return db
        .prepare(
          `UPDATE telegram_pending_alerts
              SET attempts = attempts + 1,
                  not_before_at = ?,
                  last_error_class = ?,
                  retry_after_sec = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .bind(notBeforeAt, update.errorClass, update.retryAfterSec, nowSec, update.id);
    }));
  }

  return {
    attempted,
    sent,
    blocked,
    blockedCleanupFailed,
    retryQueued,
    dropped,
    droppedPermanentFailure,
    droppedMaxAttemptsFallback,
    deferred,
    rateLimited,
    retryAfterSec: rateLimitRetryAfterSec,
    notBeforeAt: rateLimitNotBeforeAt,
  };
}

export async function enqueuePendingAlerts(
  db: D1Database,
  messages: BatchMessage[],
  nowSec: number,
  options: PendingEnqueueOptions = {},
): Promise<void> {
  if (messages.length === 0) return;

  const staleCutoff = nowSec - PENDING_TTL_SEC;
  const stmts = messages.map((msg) =>
    db
      .prepare(
        `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, disable_notification, created_at, not_before_at,
           last_error_class, retry_after_sec, updated_at, dedupe_key, chunk_index
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           message_html = excluded.message_html,
           disable_notification = excluded.disable_notification,
           created_at = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN excluded.created_at
             ELSE telegram_pending_alerts.created_at
           END,
           attempts = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN 0
             ELSE telegram_pending_alerts.attempts
           END,
           not_before_at = CASE
             WHEN excluded.not_before_at IS NULL THEN telegram_pending_alerts.not_before_at
             WHEN telegram_pending_alerts.not_before_at IS NULL THEN excluded.not_before_at
             ELSE MAX(telegram_pending_alerts.not_before_at, excluded.not_before_at)
           END,
           last_error_class = COALESCE(excluded.last_error_class, telegram_pending_alerts.last_error_class),
           retry_after_sec = COALESCE(excluded.retry_after_sec, telegram_pending_alerts.retry_after_sec),
           updated_at = excluded.updated_at,
           chunk_index = excluded.chunk_index`,
      )
      .bind(
        msg.chatId,
        msg.html,
        msg.disableNotification ? 1 : 0,
        nowSec,
        options.notBeforeAt ?? null,
        options.lastErrorClass ?? null,
        options.retryAfterSec ?? null,
        nowSec,
        buildDedupeKey(msg),
        msg.chunkIndex ?? 0,
        staleCutoff,
        staleCutoff,
      ),
  );
  await batchExecute(db, stmts);
}

export async function loadChatsInBackoff(
  db: D1Database,
  nowSec: number,
): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT chat_id
         FROM telegram_pending_alerts
        WHERE not_before_at IS NOT NULL AND not_before_at > ?`,
    )
    .bind(nowSec)
    .all<{ chat_id: string }>();
  return new Set((rows.results ?? []).map((row) => row.chat_id));
}

export async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const cutoff = nowSec - PENDING_TTL_SEC;
  const result = await db
    .prepare("DELETE FROM telegram_pending_alerts WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}
