import { buildInClause, chunkArray, batchExecute } from "../../lib/db";
import {
  schedulePerChatBatches,
  sendToChat,
  type BatchMessage,
  type BatchResult,
} from "../../lib/telegram";
import { SNOOZE_REPLY_MARKUP } from "../../lib/telegram-alerts";
import { toErrorMessage } from "../../lib/error-utils";
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
  pendingBackoffSec,
  readTelegramGlobalBackoff,
  setTelegramGlobalBackoff,
} from "./backoff";
import {
  deadLetterTerminalPendingRows,
  deletePendingAlertsByIds,
  PENDING_DELETE_CHUNK_SIZE,
} from "./dead-letter";
import {
  flushChatSuccessResets,
  handleBlockedChat,
} from "./lifecycle";
import { clearPendingAlertsForDisabledChat } from "./cleanup";
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

const PENDING_CLAIM_TTL_SEC = 10 * 60;
const DEFAULT_RETRY_DELAY_SEC = PENDING_BACKOFF_SCHEDULE_SEC[0];

interface PendingDrainOptions {
  maxPriority?: number | null;
  softDeadlineAtMs?: number | null;
  markTelegramDeliveryStarted?: () => void;
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

function createPendingClaimOwner(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return `pending-${cryptoObj.randomUUID()}`;
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function appendPendingTargetStatus(
  targetStatusUpdates: TelegramAlertTargetStatusUpdate[],
  row: Pick<PendingAlertRow, "dedupe_key"> | undefined,
  status: TelegramAlertTargetStatusUpdate["status"],
  at: number,
  errorClass?: string | null,
): void {
  if (!row?.dedupe_key) return;
  const update: TelegramAlertTargetStatusUpdate = {
    targetKey: row.dedupe_key,
    status,
    at,
  };
  if (errorClass !== undefined) {
    update.errorClass = errorClass;
  }
  targetStatusUpdates.push(update);
}

async function reconcileTerminalTargetRows(db: D1Database, nowSec: number): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_pending_alerts
          SET delivery_state = 'sent',
              delivery_completed_at = COALESCE(delivery_completed_at, ?),
              updated_at = ?
        WHERE delivery_state = 'pending'
          AND dedupe_key IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM telegram_alert_job_targets t
             WHERE t.pending_dedupe_key = telegram_pending_alerts.dedupe_key
               AND t.status IN ('sent', 'expired')
          )`,
    )
    .bind(nowSec, nowSec)
    .run();
}

async function selectPendingClaimCandidateIds(
  db: D1Database,
  nowSec: number,
  limit: number,
  maxPriority: number | null,
): Promise<number[]> {
  const candidateRows = await db
    .prepare(
      `SELECT p.id
         FROM telegram_pending_alerts p
        WHERE COALESCE(p.expires_at, p.created_at + ?) > ?
          AND p.delivery_state = 'pending'
          AND (
            p.dedupe_key IS NULL
            OR NOT EXISTS (
              SELECT 1
                FROM telegram_alert_job_targets t
               WHERE t.pending_dedupe_key = p.dedupe_key
                 AND t.status IN ('sent', 'expired')
            )
          )
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

async function markPendingRowsSending(
  db: D1Database,
  ids: readonly number[],
  owner: string,
  nowSec: number,
): Promise<void> {
  if (ids.length === 0) return;
  const changed = await batchExecute(db, ids.map((id) =>
    db
      .prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = 'sending',
                delivery_started_at = COALESCE(delivery_started_at, ?),
                updated_at = ?
          WHERE id = ?
            AND processing_owner = ?
            AND delivery_state = 'pending'`,
      )
      .bind(nowSec, nowSec, id, owner),
  ));
  if (changed !== ids.length) {
    throw new Error(`Telegram pending delivery ownership changed before send (${changed}/${ids.length})`);
  }
}

async function markSentPendingAlerts(
  db: D1Database,
  ids: readonly number[],
  owner: string,
  nowSec: number,
): Promise<void> {
  if (ids.length === 0) return;
  const changed = await batchExecute(db, ids.map((id) =>
    db
      .prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = 'sent',
                delivery_completed_at = ?,
                updated_at = ?
          WHERE id = ?
            AND processing_owner = ?
            AND delivery_state = 'sending'`,
      )
      .bind(nowSec, nowSec, id, owner),
  ));
  if (changed !== ids.length) {
    throw new Error(`Telegram sent-state persistence was not confirmed (${changed}/${ids.length})`);
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
    const message = toErrorMessage(error);
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
                delivery_state = 'pending',
                delivery_started_at = NULL,
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

/** The Telegram send result enriched with the originating pending row's id/chat/attempts. */
type PendingSendResult = { id: number; chatId: string; attempts: number } & BatchResult;

/**
 * Pure classification of a single send result into the mutually-exclusive
 * outcome that the drain loop should record. Side effects (DB writes, blocked-
 * chat cascade, global backoff) stay in the loop; this only decides the
 * outcome and the row updates to enqueue, so the exhaustive switch makes a
 * missing branch a type error rather than a silently dropped increment.
 */
type PendingResultClassification =
  | { kind: "sent" }
  | { kind: "blocked"; errorClass: string }
  | {
      kind: "retry";
      retryUpdate: PendingRetryUpdate;
      targetErrorClass: string | null;
      rateLimit: { retryAfterSec: number | null; notBeforeAt: number; scope: "chat" | "global" } | null;
    }
  | { kind: "dropped-max-attempts"; errorClass: string }
  | { kind: "dropped-permanent"; errorClass: string };

function classifyPendingSendResult(
  result: PendingSendResult,
  nowSec: number,
): PendingResultClassification {
  if (result.ok) {
    return { kind: "sent" };
  }
  if (result.blocked) {
    return { kind: "blocked", errorClass: result.errorClass ?? "blocked" };
  }
  if (result.retryable && result.attempts < PENDING_MAX_ATTEMPTS) {
    // Age-based retry: keep retrying inside the TTL window (enforced at SELECT time).
    // The defensive PENDING_MAX_ATTEMPTS ceiling prevents a pathological row from looping
    // forever with sub-second backoffs.
    const isGlobalRateLimit = result.errorClass === "rate_limit" && result.rateLimitScope === "global";
    const backoffNotBeforeAt = nowSec + pendingBackoffSec(result.attempts, result.retryAfterSec);
    return {
      kind: "retry",
      retryUpdate: {
        id: result.id,
        retryAfterSec: result.retryAfterSec,
        errorClass: result.errorClass,
        notBeforeAt: isGlobalRateLimit ? null : backoffNotBeforeAt,
      },
      targetErrorClass: result.errorClass ?? null,
      rateLimit: result.errorClass === "rate_limit"
        ? {
            retryAfterSec: result.retryAfterSec,
            notBeforeAt: backoffNotBeforeAt,
            scope: result.rateLimitScope === "global" ? "global" : "chat",
          }
        : null,
    };
  }
  if (result.retryable) {
    // Hit the defensive attempts ceiling while still retryable.
    return { kind: "dropped-max-attempts", errorClass: result.errorClass ?? "max_attempts" };
  }
  // Non-retryable, non-blocked: classify as permanent failure (e.g. 400 bad_request, 401 auth_error).
  return { kind: "dropped-permanent", errorClass: result.errorClass ?? "permanent_failure" };
}

export async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
  options: PendingDrainOptions = {},
): Promise<PendingDrainResult> {
  if (limit <= 0) return emptyDrainResult();
  const nowSec = Math.floor(Date.now() / 1000);
  await reconcileTerminalTargetRows(db, nowSec);
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
  let deferred = 0;
  let blockedCleanedUp = 0;
  let blockedCleanupFailed = 0;
  const sentIdsToDelete: number[] = [];
  const blockedRowsToDelete: DeadLetterPendingRow[] = [];
  const permanentRowsToDelete: DeadLetterPendingRow[] = [];
  const maxAttemptRowsToDelete: DeadLetterPendingRow[] = [];
  const completedIds = new Set<number>();
  const retryUpdates: PendingRetryUpdate[] = [];
  const deferUpdates: PendingDeferUpdate[] = [];
  // Per-result outcome kinds, tallied in one pass after the send loop so each
  // counter derives from exactly one source of truth.
  const outcomeKinds: PendingResultClassification["kind"][] = [];
  let rateLimited = false;
  let rateLimitRetryAfterSec: number | null = null;
  let rateLimitNotBeforeAt: number | null = null;
  const deliveryDiagnostics: PendingDeliveryDiagnostic[] = [];
  const targetStatusUpdates: TelegramAlertTargetStatusUpdate[] = [];
  const pendingById = new Map(pending.map((row) => [row.id, row] as const));
  const blockedChatsThisLoop = new Set<string>();
  const chatsToResetOnSuccess = new Set<string>();
  const disabledChatIds = new Set<string>();
  const softDeadlineAtMs = Number.isFinite(options.softDeadlineAtMs)
    ? options.softDeadlineAtMs
    : null;

  const sendableRows: Array<{ chatId: string; row: PendingAlertRow; message: BatchMessage }> = [];
  for (const row of pending) {
    if (isPendingRowSnoozed(row, nowSec)) {
      deferred++;
      deferUpdates.push({
        id: row.id,
        notBeforeAt: Math.max(row.alert_snooze_until_ts ?? 0, nowSec + DEFAULT_RETRY_DELAY_SEC),
      });
      appendPendingTargetStatus(targetStatusUpdates, row, "queued", nowSec);
      completedIds.add(row.id);
      continue;
    }
    sendableRows.push({
      chatId: row.chat_id,
      row,
      message: {
        chatId: row.chat_id,
        html: row.message_html,
        disableNotification: shouldSilencePendingRow(row, nowSec),
        replyMarkup: SNOOZE_REPLY_MARKUP,
        ...(row.chunk_index != null ? { chunkIndex: row.chunk_index } : {}),
        ...(row.alert_type != null ? { alertType: row.alert_type } : {}),
      },
    });
  }

  const scheduledResults = await schedulePerChatBatches(
    sendableRows,
    SEND_BATCH_SIZE,
    ({ row, message }) =>
      sendToChat(row.chat_id, row.message_html, botToken, {
        disableWebPagePreview: true,
        disableNotification: message.disableNotification,
        replyMarkup: message.replyMarkup,
        signal,
      }),
    {
      signal,
      softDeadlineAtMs,
      beforeSendBatch: async (entries) => {
        await markPendingRowsSending(
          db,
          entries.map(({ item }) => item.row.id),
          claimOwner,
          nowSec,
        );
        options.markTelegramDeliveryStarted?.();
      },
    },
  );

  const predecessorRetryAtByChat = new Map<string, number>();
  for (const [index, scheduledResult] of scheduledResults.entries()) {
    const sendable = sendableRows[index];
    if (!sendable) continue;
    const result: PendingSendResult = {
      ...scheduledResult,
      id: sendable.row.id,
      chatId: sendable.chatId,
      attempts: sendable.row.attempts,
    };
    const pendingRow = pendingById.get(result.id);
    const pushTargetStatus = (
      status: TelegramAlertTargetStatusUpdate["status"],
      errorClass?: string | null,
    ) => appendPendingTargetStatus(targetStatusUpdates, pendingRow, status, nowSec, errorClass);

    if (result.attempted === false) {
      if (result.skippedReason === "predecessor_failure" && result.retryable) {
        const notBeforeAt =
          predecessorRetryAtByChat.get(result.chatId) ??
          nowSec + pendingBackoffSec(result.attempts, result.retryAfterSec);
        deferred++;
        deferUpdates.push({ id: result.id, notBeforeAt });
        pushTargetStatus("queued", result.errorClass);
        completedIds.add(result.id);
        continue;
      }
      if (result.skippedReason !== "predecessor_failure") {
        continue;
      }
    } else {
      attempted++;
      deliveryDiagnostics.push(
        result.ok
          ? { chatId: result.chatId, ok: true }
          : { chatId: result.chatId, ok: false, errorClass: result.errorClass },
      );
    }

    const classification = classifyPendingSendResult(result, nowSec);
    outcomeKinds.push(classification.kind);
    completedIds.add(result.id);

    switch (classification.kind) {
      case "sent": {
        sentIdsToDelete.push(result.id);
        pushTargetStatus("sent");
        chatsToResetOnSuccess.add(result.chatId);
        break;
      }
      case "blocked": {
        if (pendingRow) blockedRowsToDelete.push({ ...pendingRow, last_error_class: result.errorClass ?? pendingRow.last_error_class });
        pushTargetStatus("failed", classification.errorClass);
        const blockedCascade = await handleBlockedChat(db, result.chatId, nowSec, blockedChatsThisLoop);
        if (blockedCascade.disabled) {
          blockedCleanedUp++;
          disabledChatIds.add(result.chatId);
        } else if (blockedCascade.failed) {
          blockedCleanupFailed++;
        }
        break;
      }
      case "retry": {
        retryUpdates.push(classification.retryUpdate);
        pushTargetStatus("queued", classification.targetErrorClass);
        if (classification.retryUpdate.notBeforeAt != null) {
          predecessorRetryAtByChat.set(result.chatId, classification.retryUpdate.notBeforeAt);
        }
        if (classification.rateLimit) {
          rateLimited = true;
          rateLimitRetryAfterSec = classification.rateLimit.retryAfterSec;
          rateLimitNotBeforeAt = Math.max(rateLimitNotBeforeAt ?? 0, classification.rateLimit.notBeforeAt);
          if (classification.rateLimit.scope === "global") {
            await setTelegramGlobalBackoff(db, rateLimitNotBeforeAt);
          }
        }
        break;
      }
      case "dropped-max-attempts": {
        if (pendingRow) maxAttemptRowsToDelete.push({ ...pendingRow, last_error_class: result.errorClass ?? pendingRow.last_error_class });
        pushTargetStatus("failed", classification.errorClass);
        break;
      }
      case "dropped-permanent": {
        if (pendingRow) permanentRowsToDelete.push({ ...pendingRow, last_error_class: result.errorClass ?? pendingRow.last_error_class });
        pushTargetStatus("failed", classification.errorClass);
        break;
      }
    }
  }

  // Single-pass tally: every counter derives from the recorded outcome kinds.
  const sent = outcomeKinds.filter((kind) => kind === "sent").length;
  const blocked = outcomeKinds.filter((kind) => kind === "blocked").length;
  const retryQueued = outcomeKinds.filter((kind) => kind === "retry").length;
  const droppedMaxAttemptsFallback = outcomeKinds.filter((kind) => kind === "dropped-max-attempts").length;
  const droppedPermanentFailure = outcomeKinds.filter((kind) => kind === "dropped-permanent").length;
  const dropped = droppedMaxAttemptsFallback + droppedPermanentFailure;

  await flushChatSuccessResets(db, chatsToResetOnSuccess);
  await markSentPendingAlerts(db, sentIdsToDelete, claimOwner, nowSec);
  await recordPendingDrainTelemetry(db, deliveryDiagnostics, targetStatusUpdates);

  for (const chatId of disabledChatIds) {
    const cleanup = await clearPendingAlertsForDisabledChat(db, chatId, nowSec, completedIds);
    if (cleanup.failed) {
      blockedCleanupFailed++;
    }
  }

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
