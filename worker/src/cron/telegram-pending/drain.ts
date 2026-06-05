import { buildInClause, chunkArray, batchExecute } from "../../lib/db";
import { sendToChat } from "../../lib/telegram";
import { SNOOZE_REPLY_MARKUP } from "../../lib/telegram-alerts";
import {
  PENDING_MAX_ATTEMPTS,
  PENDING_BACKOFF_SCHEDULE_SEC,
  PENDING_TTL_SEC,
  SEND_BATCH_SIZE,
  TELEGRAM_PENDING_PRIORITY,
} from "../../lib/telegram-constants";
import { recordTelegramDeliveryOutcomes } from "../../lib/telegram-usage-analytics";
import { isQuietHoursActive } from "../telegram-quiet-hours";
import {
  recordTelegramAlertTargetStatuses,
  type TelegramAlertTargetStatusUpdate,
} from "../telegram-alert-target-status";
import {
  pendingRetryDelaySec,
  readTelegramGlobalBackoff,
  setTelegramGlobalBackoff,
} from "./backoff";
import {
  deadLetterTerminalPendingRows,
  deletePendingAlertsByIds,
  PENDING_DELETE_CHUNK_SIZE,
} from "./dead-letter";
import {
  disableBlockedSubscriber,
  registerSubscriberBlockAndShouldDisable,
  resetSubscriberBlockCount,
} from "./lifecycle";
import {
  emptyDrainResult,
  type DeadLetterPendingRow,
  type PendingAlertRow,
  type PendingDeferUpdate,
  type PendingDeliveryDiagnostic,
  type PendingDrainResult,
  type PendingRetryUpdate,
  type PendingDeadLetterReason,
} from "./types";
import { logTelegramEvent } from "../../lib/telegram-log";

const PENDING_CLAIM_TTL_SEC = 15 * 60;
const DEFAULT_RETRY_DELAY_SEC = PENDING_BACKOFF_SCHEDULE_SEC[0];

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

function createPendingClaimOwner(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return `pending-${cryptoObj.randomUUID()}`;
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function selectPendingClaimCandidateIds(
  db: D1Database,
  nowSec: number,
  limit: number,
  maxPriority: number | null,
): Promise<number[]> {
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
                 p.created_at ASC,
                 p.chunk_index ASC
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

  return (candidateRows.results ?? [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id));
}

async function claimPendingRowsByIds(
  db: D1Database,
  ids: readonly number[],
  owner: string,
  nowSec: number,
  claimExpiresAt: number,
): Promise<void> {
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
}

async function loadClaimedPendingRows(
  db: D1Database,
  owner: string,
  limit: number,
): Promise<PendingAlertRow[]> {
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
                 p.created_at ASC,
                 p.chunk_index ASC
        LIMIT ?`,
    )
    .bind(owner, TELEGRAM_PENDING_PRIORITY.legacy, limit)
    .all<PendingAlertRow>();

  return rows.results ?? [];
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

async function recordPendingDrainTelemetry(
  db: D1Database,
  deliveryDiagnostics: PendingDeliveryDiagnostic[],
  targetStatusUpdates: TelegramAlertTargetStatusUpdate[],
): Promise<void> {
  await recordTelegramDeliveryOutcomes(db, deliveryDiagnostics);
  await recordTelegramAlertTargetStatuses(db, targetStatusUpdates);
}

async function deleteSentPendingAlerts(
  db: D1Database,
  sentIdsToDelete: readonly number[],
): Promise<void> {
  if (sentIdsToDelete.length === 0) return;
  try {
    await deletePendingAlertsByIds(db, sentIdsToDelete);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to delete sent pending alerts: ${message}`,
      action: "delete-sent-pending",
      module: "telegram-pending-drain",
      rowCount: sentIdsToDelete.length,
    });
  }
}

async function deadLetterAndDeleteTerminalPendingGroups(
  db: D1Database,
  groups: Array<{ rows: DeadLetterPendingRow[]; reason: PendingDeadLetterReason }>,
  nowSec: number,
): Promise<void> {
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    const deadLettered = await deadLetterTerminalPendingRows(db, group.rows, nowSec, group.reason);
    if (!deadLettered) continue;
    await deletePendingAlertsByIds(db, group.rows.map((row) => row.id));
  }
}

async function persistPendingDeferrals(
  db: D1Database,
  deferUpdates: readonly PendingDeferUpdate[],
  nowSec: number,
): Promise<void> {
  if (deferUpdates.length === 0) return;
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

async function persistPendingRetries(
  db: D1Database,
  retryUpdates: readonly PendingRetryUpdate[],
  nowSec: number,
): Promise<void> {
  if (retryUpdates.length === 0) return;
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

async function claimDuePendingRows(
  db: D1Database,
  nowSec: number,
  limit: number,
  owner: string,
  maxPriority: number | null,
): Promise<PendingAlertRow[]> {
  const claimExpiresAt = nowSec + PENDING_CLAIM_TTL_SEC;
  const ids = await selectPendingClaimCandidateIds(db, nowSec, limit, maxPriority);
  if (ids.length === 0) return [];

  await claimPendingRowsByIds(db, ids, owner, nowSec, claimExpiresAt);
  return loadClaimedPendingRows(db, owner, limit);
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
  const retryUpdates: PendingRetryUpdate[] = [];
  const deferUpdates: PendingDeferUpdate[] = [];
  let rateLimited = false;
  let globalRateLimited = false;
  let rateLimitRetryAfterSec: number | null = null;
  let rateLimitNotBeforeAt: number | null = null;
  const deliveryDiagnostics: PendingDeliveryDiagnostic[] = [];
  const targetStatusUpdates: TelegramAlertTargetStatusUpdate[] = [];
  const pendingById = new Map(pending.map((row) => [row.id, row] as const));
  const blockedChatsThisLoop = new Set<string>();

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
        if (!blockedChatsThisLoop.has(result.chatId)) {
          blockedChatsThisLoop.add(result.chatId);
          const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, result.chatId, nowSec);
          if (shouldDisable) {
            if (await disableBlockedSubscriber(db, result.chatId)) {
              blockedCleanedUp++;
            } else {
              blockedCleanupFailed++;
            }
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

  await recordPendingDrainTelemetry(db, deliveryDiagnostics, targetStatusUpdates);

  const terminalDeleteGroups: Array<{ rows: DeadLetterPendingRow[]; reason: PendingDeadLetterReason }> = [
    { rows: blockedRowsToDelete, reason: "blocked_disabled" },
    { rows: permanentRowsToDelete, reason: "permanent_failure" },
    { rows: maxAttemptRowsToDelete, reason: "max_attempts" },
  ];
  await deleteSentPendingAlerts(db, sentIdsToDelete);
  await deadLetterAndDeleteTerminalPendingGroups(db, terminalDeleteGroups, nowSec);
  await persistPendingDeferrals(db, deferUpdates, nowSec);
  await persistPendingRetries(db, retryUpdates, nowSec);

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
