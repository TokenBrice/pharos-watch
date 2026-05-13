import { sendToChat, type BatchMessage, type TelegramSendErrorClass } from "../lib/telegram";
import { batchExecute, buildInClause, chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../lib/db";
import { getCache, setCache } from "../lib/db-cache";
import { SNOOZE_REPLY_MARKUP } from "../lib/telegram-alerts";
import {
  BLOCK_STRIKE_WINDOW_SEC,
  PENDING_BACKOFF_SCHEDULE_SEC,
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_TTL_SEC,
  SEND_BATCH_SIZE,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
  TELEGRAM_SPLIT_VERSION,
} from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";
import { recordTelegramDeliveryOutcomes } from "../lib/telegram-usage-analytics";
import { isQuietHoursActive } from "./telegram-quiet-hours";
import { recordTelegramAlertTargetStatuses, type TelegramAlertTargetStatusUpdate } from "./telegram-alert-target-status";
import type { TelegramAlertType } from "@shared/types/status";

// ---------- Constants ----------

// Re-export Telegram-related constants from the centralized module so existing
// import paths (e.g. `import { PENDING_TTL_SEC } from "./telegram-pending-queue"`)
// keep working without churn.
export {
  BLOCK_STRIKE_WINDOW_SEC,
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_BACKOFF_SCHEDULE_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_TTL_SEC,
  SEND_BATCH_SIZE,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
};

const PENDING_BACKOFF_CAP_SEC = PENDING_BACKOFF_SCHEDULE_SEC[PENDING_BACKOFF_SCHEDULE_SEC.length - 1];
export const TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY = "telegram:global-send-backoff-until";
const PENDING_CLAIM_TTL_SEC = 15 * 60;
const PENDING_DELETE_CHUNK_SIZE = D1_SAFE_IN_CLAUSE_BIND_LIMIT;

// ---------- Types ----------

export interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  expires_at: number | null;
  attempts: number;
  not_before_at: number | null;
  priority: number | null;
  source_type: string | null;
  alert_type: TelegramAlertType | null;
  last_error_class: string | null;
  dedupe_key: string | null;
  chunk_index: number | null;
  alert_snooze_until_ts: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
}

type PendingDeadLetterReason =
  | "ttl_expired"
  | "permanent_failure"
  | "max_attempts"
  | "blocked_disabled"
  | "manual_clear";

interface DeadLetterPendingRow {
  id: number;
  chat_id: string;
  message_html: string;
  created_at: number;
  attempts: number | null;
  last_error_class?: string | null;
  dedupe_key?: string | null;
  chunk_index?: number | null;
  priority?: number | null;
  source_type?: string | null;
  alert_type?: string | null;
}

export interface PendingDrainResult {
  attempted: number;
  sent: number;
  blocked: number;
  blockedCleanedUp: number;
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
  sourceType?: "risk_alert" | "admin_broadcast" | "legacy";
  priority?: number | null;
  ttlSec?: number | null;
}

export interface PendingCapacitySnapshot {
  total: number;
  active: number;
  due: number;
  deferred: number;
  expired: number;
  nearTtl: number;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  drainBudgetPerRun: number;
  dispatchIntervalSec: number;
}

const DEFAULT_RETRY_DELAY_SEC = PENDING_BACKOFF_SCHEDULE_SEC[0];

// Two-strike rule for 403 (block) handling — see BLOCK_STRIKE_WINDOW_SEC in
// `telegram-constants.ts`. Imported + re-exported at the top of this file.

function emptyDrainResult(): PendingDrainResult {
  return {
    attempted: 0,
    sent: 0,
    blocked: 0,
    blockedCleanedUp: 0,
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

export function estimateTelegramDrainTimeSec(
  messageCount: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
  dispatchIntervalSec: number = TELEGRAM_DISPATCH_INTERVAL_SEC,
): number {
  if (!Number.isFinite(messageCount) || messageCount <= 0) return 0;
  const budget = Math.max(1, Math.floor(drainBudgetPerRun));
  return Math.ceil(messageCount / budget) * dispatchIntervalSec;
}

function pendingPriorityForAlertType(alertType: TelegramAlertType | undefined): number {
  if (!alertType) return TELEGRAM_PENDING_PRIORITY.riskAlert;
  return TELEGRAM_PENDING_PRIORITY[alertType] ?? TELEGRAM_PENDING_PRIORITY.riskAlert;
}

function resolvePendingPriority(message: BatchMessage, options: PendingEnqueueOptions): number {
  if (options.priority != null && Number.isFinite(options.priority)) {
    return Math.max(0, Math.floor(options.priority));
  }
  if (options.sourceType === "admin_broadcast") return TELEGRAM_PENDING_PRIORITY.adminBroadcast;
  if (options.sourceType === "legacy") return TELEGRAM_PENDING_PRIORITY.legacy;
  return pendingPriorityForAlertType(message.alertType);
}

function resolvePendingSourceType(options: PendingEnqueueOptions): "risk_alert" | "admin_broadcast" | "legacy" {
  return options.sourceType ?? "risk_alert";
}

function resolvePendingTtlSec(message: BatchMessage, options: PendingEnqueueOptions): number {
  if (options.ttlSec != null && Number.isFinite(options.ttlSec) && options.ttlSec > 0) {
    return Math.floor(options.ttlSec);
  }
  if (options.sourceType === "admin_broadcast") return TELEGRAM_ALERT_TTL_SEC.adminBroadcast;
  if (options.sourceType === "legacy") return TELEGRAM_ALERT_TTL_SEC.legacy;
  return message.alertType ? TELEGRAM_ALERT_TTL_SEC[message.alertType] : PENDING_TTL_SEC;
}

function normalizeCapacityNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeCapacityTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export async function readPendingCapacitySnapshot(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
): Promise<PendingCapacitySnapshot> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(expires_at, created_at + ?) <= ? THEN 1 ELSE 0 END) AS expired,
                SUM(CASE
                      WHEN COALESCE(expires_at, created_at + ?) > ?
                       AND (not_before_at IS NULL OR not_before_at <= ?)
                      THEN 1 ELSE 0
                    END) AS due,
                SUM(CASE
                      WHEN COALESCE(expires_at, created_at + ?) > ?
                       AND not_before_at IS NOT NULL
                       AND not_before_at > ?
                      THEN 1 ELSE 0
                    END) AS deferred,
                SUM(CASE
                      WHEN COALESCE(expires_at, created_at + ?) > ?
                       AND COALESCE(expires_at, created_at + ?) <= ?
                      THEN 1 ELSE 0
                    END) AS near_ttl,
                MIN(CASE
                      WHEN COALESCE(expires_at, created_at + ?) > ?
                      THEN created_at
                    END) AS oldest_pending_created_at,
                MIN(CASE
                      WHEN COALESCE(expires_at, created_at + ?) > ?
                       AND (not_before_at IS NULL OR not_before_at <= ?)
                      THEN created_at
                    END) AS oldest_due_created_at
           FROM telegram_pending_alerts`,
      )
      .bind(
        PENDING_TTL_SEC, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        PENDING_TTL_SEC, nowSec, PENDING_TTL_SEC, nowSec + PENDING_NEAR_TTL_WINDOW_SEC,
        PENDING_TTL_SEC, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
      )
      .first<{
        total: number | null;
        expired: number | null;
        due: number | null;
        deferred: number | null;
        near_ttl: number | null;
        oldest_pending_created_at: number | null;
        oldest_due_created_at: number | null;
      }>();

    const total = normalizeCapacityNumber(row?.total);
    const expired = normalizeCapacityNumber(row?.expired);
    const due = normalizeCapacityNumber(row?.due);
    const deferred = normalizeCapacityNumber(row?.deferred);
    const nearTtl = normalizeCapacityNumber(row?.near_ttl);
    const active = Math.max(0, total - expired);
    const oldestPendingCreatedAt = normalizeCapacityTimestamp(row?.oldest_pending_created_at);
    const oldestDueCreatedAt = normalizeCapacityTimestamp(row?.oldest_due_created_at);

    return {
      total,
      active,
      due,
      deferred,
      expired,
      nearTtl,
      oldestPendingAgeSec: oldestPendingCreatedAt == null ? null : Math.max(0, nowSec - oldestPendingCreatedAt),
      oldestDuePendingAgeSec: oldestDueCreatedAt == null ? null : Math.max(0, nowSec - oldestDueCreatedAt),
      estimatedDrainTimeSec: estimateTelegramDrainTimeSec(active, drainBudgetPerRun),
      drainBudgetPerRun,
      dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to read pending capacity snapshot: ${message}`,
      action: "read-pending-capacity",
      module: "telegram-pending-queue",
    });
    return {
      total: 0,
      active: 0,
      due: 0,
      deferred: 0,
      expired: 0,
      nearTtl: 0,
      oldestPendingAgeSec: null,
      oldestDuePendingAgeSec: null,
      estimatedDrainTimeSec: 0,
      drainBudgetPerRun,
      dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
    };
  }
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
    row.timezone,
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
    logTelegramEvent({
      message: `Failed to register block strike: ${message}`,
      chatId,
      action: "register-block-strike",
      module: "telegram-pending-queue",
    });
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
    logTelegramEvent({
      message: `Failed to reset block count: ${message}`,
      chatId,
      action: "reset-block-count",
      module: "telegram-pending-queue",
    });
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
      db
        .prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id=?")
        .bind(chatId),
    ]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      message: `Failed to disable blocked subscriber: ${message}`,
      chatId,
      action: "disable-blocked-subscriber",
      module: "telegram-pending-queue",
    });
    return false;
  }
}

// ---------- Pending Queue Operations ----------

export async function setTelegramGlobalBackoff(db: D1Database, notBeforeAt: number | null): Promise<void> {
  if (notBeforeAt == null) return;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const existing = await readTelegramGlobalBackoff(db, nowSec);
    await setCache(db, TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY, String(Math.max(existing ?? 0, notBeforeAt)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to set global Telegram backoff: ${message}`,
      action: "set-global-backoff",
      module: "telegram-pending-queue",
    });
  }
}

export async function readTelegramGlobalBackoff(db: D1Database, nowSec: number): Promise<number | null> {
  try {
    const cached = await getCache(db, TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY);
    if (!cached) return null;
    const parsed = Number(cached.value);
    return Number.isFinite(parsed) && parsed > nowSec ? Math.floor(parsed) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to read global Telegram backoff: ${message}`,
      action: "read-global-backoff",
      module: "telegram-pending-queue",
    });
    return null;
  }
}

function createPendingClaimOwner(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return `pending-${cryptoObj.randomUUID()}`;
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function deletePendingAlertsByIds(db: D1Database, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  let deleted = 0;
  for (const idChunk of chunkArray(ids, PENDING_DELETE_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      .prepare(`DELETE FROM telegram_pending_alerts WHERE id IN (${inClause.sql})`)
      .bind(...inClause.binds)
      .run();
    deleted += Number(result.meta?.changes ?? 0);
  }
  return deleted;
}

async function releasePendingClaimsByIds(
  db: D1Database,
  ids: readonly number[],
  owner: string,
  nowSec: number,
): Promise<void> {
  if (ids.length === 0) return;
  for (const idChunk of chunkArray(ids, PENDING_DELETE_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    await db
      .prepare(
        `UPDATE telegram_pending_alerts
            SET processing_owner = NULL,
                processing_started_at = NULL,
                processing_expires_at = NULL,
                updated_at = ?
          WHERE processing_owner = ?
            AND id IN (${inClause.sql})`,
      )
      .bind(nowSec, owner, ...inClause.binds)
      .run();
  }
}

async function insertPendingDeadLetters(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  nowSec: number,
  reason: PendingDeadLetterReason,
): Promise<void> {
  if (rows.length === 0) return;
  await batchExecute(db, rows.map((row) =>
    db
      .prepare(
        `INSERT INTO telegram_alert_dead_letters (
           pending_id, chat_id, message_html, source_type, alert_type, priority,
           created_at, expired_at, attempts, last_error_class, reason, dedupe_key, chunk_index
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.chat_id,
        row.message_html,
        row.source_type ?? "legacy",
        row.alert_type ?? null,
        row.priority ?? TELEGRAM_PENDING_PRIORITY.legacy,
        row.created_at,
        nowSec,
        row.attempts ?? 0,
        row.last_error_class ?? null,
        reason,
        row.dedupe_key ?? null,
        row.chunk_index ?? 0,
      ),
  ));
}

async function deadLetterTerminalPendingRows(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  nowSec: number,
  reason: PendingDeadLetterReason,
): Promise<boolean> {
  if (rows.length === 0) return true;
  try {
    await insertPendingDeadLetters(db, rows, nowSec, reason);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to dead-letter terminal pending alerts: ${message}`,
      action: "dead-letter-terminal-pending",
      module: "telegram-pending-queue",
      reason,
      rowCount: rows.length,
    });
    return false;
  }
}

export async function clearPendingAlertsForAdmin(
  db: D1Database,
  filter: { chatId: string } | { olderThanCutoffSec: number },
  nowSec: number,
): Promise<number> {
  let deleted = 0;

  for (;;) {
    const query = "chatId" in filter
      ? {
          sql: `SELECT id, chat_id, message_html, created_at, attempts, last_error_class,
                       dedupe_key, chunk_index, priority, source_type, alert_type
                  FROM telegram_pending_alerts
                 WHERE chat_id = ?
                 ORDER BY id ASC
                 LIMIT ?`,
          binds: [filter.chatId, PENDING_DELETE_CHUNK_SIZE] as const,
        }
      : {
          sql: `SELECT id, chat_id, message_html, created_at, attempts, last_error_class,
                       dedupe_key, chunk_index, priority, source_type, alert_type
                  FROM telegram_pending_alerts
                 WHERE created_at < ?
                 ORDER BY id ASC
                 LIMIT ?`,
          binds: [filter.olderThanCutoffSec, PENDING_DELETE_CHUNK_SIZE] as const,
        };

    const selected = await db
      .prepare(query.sql)
      .bind(...query.binds)
      .all<DeadLetterPendingRow>();
    const rows = selected.results ?? [];
    if (rows.length === 0) break;

    const deadLettered = await deadLetterTerminalPendingRows(db, rows, nowSec, "manual_clear");
    if (!deadLettered) {
      throw new Error("Failed to dead-letter Telegram pending alerts before manual clear");
    }

    await recordTelegramAlertTargetStatuses(
      db,
      rows
        .filter((row) => row.dedupe_key)
        .map((row) => ({
          targetKey: row.dedupe_key!,
          status: "failed" as const,
          at: nowSec,
          errorClass: "manual_clear",
        })),
    );

    const deletedRows = await deletePendingAlertsByIds(db, rows.map((row) => row.id));
    deleted += deletedRows;
    if (deletedRows < rows.length) {
      throw new Error(
        `Deleted ${deletedRows} of ${rows.length} selected Telegram pending alerts during manual clear`,
      );
    }
    if (rows.length < PENDING_DELETE_CHUNK_SIZE) break;
  }

  return deleted;
}

async function claimDuePendingRows(
  db: D1Database,
  nowSec: number,
  limit: number,
  owner: string,
  maxPriority: number | null,
): Promise<PendingAlertRow[]> {
  const claimExpiresAt = nowSec + PENDING_CLAIM_TTL_SEC;
  const candidateRows = await db
    .prepare(
      `SELECT p.id, p.chat_id, p.message_html
         FROM telegram_pending_alerts p
        WHERE COALESCE(p.expires_at, p.created_at + ?) > ?
          AND (p.not_before_at IS NULL OR p.not_before_at <= ?)
          AND (? IS NULL OR COALESCE(p.priority, ?) <= ?)
          AND (
            p.processing_owner IS NULL
            OR p.processing_expires_at IS NULL
            OR p.processing_expires_at <= ?
          )
        ORDER BY COALESCE(p.priority, ?) ASC,
                 COALESCE(p.not_before_at, p.created_at) ASC,
                 p.created_at ASC
        LIMIT ?`,
    )
    .bind(
      PENDING_TTL_SEC,
      nowSec,
      nowSec,
      maxPriority,
      TELEGRAM_PENDING_PRIORITY.legacy,
      maxPriority,
      nowSec,
      TELEGRAM_PENDING_PRIORITY.legacy,
      limit,
    )
    .all<{ id: number }>();

  const ids = (candidateRows.results ?? [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id));
  if (ids.length === 0) return [];

  for (const idChunk of chunkArray(ids, PENDING_DELETE_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    await db
      .prepare(
        `UPDATE telegram_pending_alerts
            SET processing_owner = ?,
                processing_started_at = ?,
                processing_expires_at = ?,
                updated_at = ?
          WHERE id IN (${inClause.sql})
            AND (
              processing_owner IS NULL
              OR processing_expires_at IS NULL
              OR processing_expires_at <= ?
            )`,
      )
      .bind(owner, nowSec, claimExpiresAt, nowSec, ...inClause.binds, nowSec)
      .run();
  }

  const rows = await db
    .prepare(
      `SELECT p.id, p.chat_id, p.message_html, p.disable_notification, p.created_at,
              p.expires_at, p.attempts, p.not_before_at, p.priority, p.source_type,
              p.alert_type, p.dedupe_key, p.chunk_index, p.last_error_class,
              u.alert_snooze_until_ts, u.quiet_hours_enabled,
              u.quiet_hours_start_utc, u.quiet_hours_end_utc, u.timezone
         FROM telegram_pending_alerts p
         LEFT JOIN telegram_subscribers u ON u.chat_id = p.chat_id
        WHERE p.processing_owner = ?
        ORDER BY COALESCE(p.priority, ?) ASC,
                 COALESCE(p.not_before_at, p.created_at) ASC,
                 p.created_at ASC
        LIMIT ?`,
    )
    .bind(owner, TELEGRAM_PENDING_PRIORITY.legacy, limit)
    .all<PendingAlertRow>();

  return rows.results ?? [];
}

export async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
  options: { maxPriority?: number | null } = {},
): Promise<PendingDrainResult> {
  if (limit <= 0) return emptyDrainResult();
  const nowSec = Math.floor(Date.now() / 1000);
  const globalBackoffUntil = await readTelegramGlobalBackoff(db, nowSec);
  if (globalBackoffUntil != null) {
    return {
      ...emptyDrainResult(),
      rateLimited: true,
      retryAfterSec: Math.max(1, globalBackoffUntil - nowSec),
      notBeforeAt: globalBackoffUntil,
    };
  }
  const maxPriority = options.maxPriority ?? null;
  const claimOwner = createPendingClaimOwner();
  const pending = await claimDuePendingRows(db, nowSec, limit, claimOwner, maxPriority);
  if (pending.length === 0) {
    return emptyDrainResult();
  }

  let attempted = 0;
  let sent = 0;
  let blocked = 0;
  let blockedCleanedUp = 0;
  let blockedCleanupFailed = 0;
  let retryQueued = 0;
  let dropped = 0;
  let droppedPermanentFailure = 0;
  let droppedMaxAttemptsFallback = 0;
  let deferred = 0;
  const sentIdsToDelete: number[] = [];
  const blockedRowsToDelete: DeadLetterPendingRow[] = [];
  const permanentRowsToDelete: DeadLetterPendingRow[] = [];
  const maxAttemptRowsToDelete: DeadLetterPendingRow[] = [];
  const completedIds = new Set<number>();
  const retryUpdates: Array<{ id: number; retryAfterSec: number | null; errorClass: TelegramSendErrorClass | null; notBeforeAt: number | null }> = [];
  const deferUpdates: Array<{ id: number; notBeforeAt: number }> = [];
  let rateLimited = false;
  let globalRateLimited = false;
  let rateLimitRetryAfterSec: number | null = null;
  let rateLimitNotBeforeAt: number | null = null;
  const deliveryDiagnostics: Array<{ chatId: string; ok: boolean; errorClass?: string | null }> = [];
  const targetStatusUpdates: TelegramAlertTargetStatusUpdate[] = [];
  const pendingById = new Map(pending.map((row) => [row.id, row] as const));

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted || globalRateLimited) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE).filter((row) => {
      if (!isPendingRowSnoozed(row, nowSec)) return true;
      deferred++;
      deferUpdates.push({ id: row.id, notBeforeAt: Math.max(row.alert_snooze_until_ts ?? 0, nowSec + DEFAULT_RETRY_DELAY_SEC) });
      if (row.dedupe_key) {
        targetStatusUpdates.push({ targetKey: row.dedupe_key, status: "queued", at: nowSec });
      }
      completedIds.add(row.id);
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
        deliveryDiagnostics.push({ chatId: result.chatId, ok: true });
        sent++;
        sentIdsToDelete.push(result.id);
        const pendingRow = pendingById.get(result.id);
        if (pendingRow?.dedupe_key) {
          targetStatusUpdates.push({ targetKey: pendingRow.dedupe_key, status: "sent", at: nowSec });
        }
        completedIds.add(result.id);
        if (!chatsResetThisLoop.has(result.chatId)) {
          chatsResetThisLoop.add(result.chatId);
          await resetSubscriberBlockCount(db, result.chatId);
        }
      } else if (result.blocked) {
        deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
        blocked++;
        const pendingRow = pendingById.get(result.id);
        if (pendingRow) blockedRowsToDelete.push({ ...pendingRow, last_error_class: result.errorClass ?? pendingRow.last_error_class });
        if (pendingRow?.dedupe_key) {
          targetStatusUpdates.push({
            targetKey: pendingRow.dedupe_key,
            status: "failed",
            at: nowSec,
            errorClass: result.errorClass ?? "blocked",
          });
        }
        completedIds.add(result.id);
        const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, result.chatId, nowSec);
        if (shouldDisable) {
          if (await disableBlockedSubscriber(db, result.chatId)) {
            blockedCleanedUp++;
          } else {
            blockedCleanupFailed++;
          }
        }
      } else if (result.retryable && result.attempts < PENDING_MAX_ATTEMPTS) {
        deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
        // Age-based retry: keep retrying inside the TTL window (enforced at SELECT time).
        // The defensive PENDING_MAX_ATTEMPTS ceiling prevents a pathological row from looping
        // forever with sub-second backoffs.
        retryQueued++;
        retryUpdates.push({
          id: result.id,
          retryAfterSec: result.retryAfterSec,
          errorClass: result.errorClass,
          notBeforeAt: result.errorClass === "rate_limit" && result.rateLimitScope === "global"
            ? null
            : nowSec + pendingRetryDelaySec(result.attempts, result.retryAfterSec),
        });
        const pendingRow = pendingById.get(result.id);
        if (pendingRow?.dedupe_key) {
          targetStatusUpdates.push({
            targetKey: pendingRow.dedupe_key,
            status: "queued",
            at: nowSec,
            errorClass: result.errorClass ?? null,
          });
        }
        completedIds.add(result.id);
        if (result.errorClass === "rate_limit") {
          rateLimited = true;
          rateLimitRetryAfterSec = result.retryAfterSec;
          rateLimitNotBeforeAt = nowSec + pendingRetryDelaySec(result.attempts, result.retryAfterSec);
          if (result.rateLimitScope === "global") {
            globalRateLimited = true;
            await setTelegramGlobalBackoff(db, rateLimitNotBeforeAt);
          }
        }
      } else if (result.retryable) {
        deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
        // Hit the defensive attempts ceiling while still retryable.
        dropped++;
        droppedMaxAttemptsFallback++;
        const pendingRow = pendingById.get(result.id);
        if (pendingRow) maxAttemptRowsToDelete.push({ ...pendingRow, last_error_class: result.errorClass ?? pendingRow.last_error_class });
        if (pendingRow?.dedupe_key) {
          targetStatusUpdates.push({
            targetKey: pendingRow.dedupe_key,
            status: "failed",
            at: nowSec,
            errorClass: result.errorClass ?? "max_attempts",
          });
        }
        completedIds.add(result.id);
      } else {
        deliveryDiagnostics.push({ chatId: result.chatId, ok: false, errorClass: result.errorClass });
        // Non-retryable, non-blocked: classify as permanent failure (e.g. 400 bad_request, 401 auth_error).
        dropped++;
        droppedPermanentFailure++;
        const pendingRow = pendingById.get(result.id);
        if (pendingRow) permanentRowsToDelete.push({ ...pendingRow, last_error_class: result.errorClass ?? pendingRow.last_error_class });
        if (pendingRow?.dedupe_key) {
          targetStatusUpdates.push({
            targetKey: pendingRow.dedupe_key,
            status: "failed",
            at: nowSec,
            errorClass: result.errorClass ?? "permanent_failure",
          });
        }
        completedIds.add(result.id);
      }
    }
  }

  await recordTelegramDeliveryOutcomes(db, deliveryDiagnostics);
  await recordTelegramAlertTargetStatuses(db, targetStatusUpdates);

  if (sentIdsToDelete.length > 0) {
    try {
      await deletePendingAlertsByIds(db, sentIdsToDelete);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTelegramEvent({
        level: "warn",
        message: `Failed to delete sent pending alerts: ${message}`,
        action: "delete-sent-pending",
        module: "telegram-pending-queue",
        rowCount: sentIdsToDelete.length,
      });
    }
  }

  const terminalDeleteGroups: Array<{ rows: DeadLetterPendingRow[]; reason: PendingDeadLetterReason }> = [
    { rows: blockedRowsToDelete, reason: "blocked_disabled" },
    { rows: permanentRowsToDelete, reason: "permanent_failure" },
    { rows: maxAttemptRowsToDelete, reason: "max_attempts" },
  ];
  for (const group of terminalDeleteGroups) {
    if (group.rows.length === 0) continue;
    const deadLettered = await deadLetterTerminalPendingRows(db, group.rows, nowSec, group.reason);
    if (!deadLettered) continue;
    await deletePendingAlertsByIds(db, group.rows.map((row) => row.id));
  }

  if (deferUpdates.length > 0) {
    await batchExecute(db, deferUpdates.map((update) =>
      db
        .prepare(
          `UPDATE telegram_pending_alerts
              SET not_before_at = ?,
                  updated_at = ?,
                  processing_owner = NULL,
                  processing_started_at = NULL,
                  processing_expires_at = NULL
            WHERE id = ?`,
        )
        .bind(update.notBeforeAt, nowSec, update.id),
    ));
  }

  if (retryUpdates.length > 0) {
    await batchExecute(db, retryUpdates.map((update) => {
      return db
        .prepare(
          `UPDATE telegram_pending_alerts
              SET attempts = attempts + 1,
                  not_before_at = ?,
                  last_error_class = ?,
                  retry_after_sec = ?,
                  updated_at = ?,
                  processing_owner = NULL,
                  processing_started_at = NULL,
                  processing_expires_at = NULL
            WHERE id = ?`,
        )
        .bind(update.notBeforeAt, update.errorClass, update.retryAfterSec, nowSec, update.id);
    }));
  }

  const unfinishedClaimedIds = pending
    .map((row) => row.id)
    .filter((id) => !completedIds.has(id));
  if (unfinishedClaimedIds.length > 0) {
    await releasePendingClaimsByIds(db, unfinishedClaimedIds, claimOwner, nowSec);
  }

  return {
    attempted,
    sent,
    blocked,
    blockedCleanedUp,
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
  const sourceType = resolvePendingSourceType(options);
  const stmts = messages.map((msg) => {
    const expiresAt = nowSec + resolvePendingTtlSec(msg, options);
    return db
      .prepare(
        `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, disable_notification, created_at, not_before_at,
           last_error_class, retry_after_sec, updated_at, dedupe_key, chunk_index,
           priority, source_type, alert_type, expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           chunk_index = excluded.chunk_index,
           priority = MIN(COALESCE(telegram_pending_alerts.priority, excluded.priority), excluded.priority),
           source_type = CASE
             WHEN excluded.priority < COALESCE(telegram_pending_alerts.priority, excluded.priority)
             THEN excluded.source_type
             ELSE telegram_pending_alerts.source_type
           END,
           alert_type = COALESCE(excluded.alert_type, telegram_pending_alerts.alert_type),
           expires_at = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN excluded.expires_at
             ELSE COALESCE(telegram_pending_alerts.expires_at, excluded.expires_at)
           END,
           processing_owner = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN NULL
             ELSE telegram_pending_alerts.processing_owner
           END,
           processing_started_at = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN NULL
             ELSE telegram_pending_alerts.processing_started_at
           END,
           processing_expires_at = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN NULL
             ELSE telegram_pending_alerts.processing_expires_at
           END`,
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
        resolvePendingPriority(msg, options),
        sourceType,
        msg.alertType ?? null,
        expiresAt,
        staleCutoff,
        staleCutoff,
        staleCutoff,
        staleCutoff,
        staleCutoff,
        staleCutoff,
      );
  });
  await batchExecute(db, stmts);
}

export async function loadChatsInBackoff(
  db: D1Database,
  nowSec: number,
): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT chat_id, MAX(not_before_at) AS not_before_at
         FROM telegram_pending_alerts
        WHERE created_at >= ?
          AND not_before_at IS NOT NULL
          AND not_before_at > ?
        GROUP BY chat_id`,
    )
    .bind(nowSec - PENDING_TTL_SEC, nowSec)
    .all<{ chat_id: string; not_before_at: number | null }>();
  return new Map(
    (rows.results ?? [])
      .filter((row): row is { chat_id: string; not_before_at: number } => row.not_before_at != null)
      .map((row) => [row.chat_id, row.not_before_at]),
  );
}

export async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const cutoff = nowSec - PENDING_TTL_SEC;
  const expiredRows = await db
    .prepare(
      `SELECT id, chat_id, message_html, created_at, attempts, last_error_class,
              dedupe_key, chunk_index, priority, source_type, alert_type
         FROM telegram_pending_alerts
        WHERE created_at < ?
           OR (expires_at IS NOT NULL AND expires_at <= ?)`,
    )
    .bind(cutoff, nowSec)
    .all<{
      id: number;
      chat_id: string;
      message_html: string;
      created_at: number;
      attempts: number | null;
      last_error_class: string | null;
      dedupe_key: string | null;
      chunk_index: number | null;
      priority: number | null;
      source_type: string | null;
      alert_type: string | null;
    }>();

  const rows = expiredRows.results ?? [];
  if (rows.length > 0) {
    const deadLettered = await deadLetterTerminalPendingRows(db, rows, nowSec, "ttl_expired");
    if (!deadLettered) {
      return 0;
    }
    await recordTelegramAlertTargetStatuses(
      db,
      rows
        .filter((row) => row.dedupe_key)
        .map((row) => ({
          targetKey: row.dedupe_key!,
          status: "expired" as const,
          at: nowSec,
          errorClass: "ttl_expired",
        })),
    );
    await deletePendingAlertsByIds(db, rows.map((row) => row.id));
    return rows.length;
  }

  return 0;
}
