import { buildInClause, chunkArray, batchExecute, executeAtomicBatch } from "../../lib/db";
import {
  schedulePerChatBatches,
  sendToChat,
  type BatchMessage,
  type BatchResult,
  type PreSendBatchResult,
} from "../../lib/telegram";
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
  recordTelegramAlertTargetCancellations,
  recordTelegramAlertTargetStatuses,
  type TelegramAlertTargetCancellation,
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
  type PendingDeliveryClaim,
  type PendingDeliveryDiagnostic,
  type PendingDrainResult,
  type PendingRetryUpdate,
  type PendingDeadLetterReason,
} from "./types";
import { logTelegramEvent } from "../../lib/telegram-log";
import {
  revalidatePendingAlertPreferences,
  type PendingPreferenceRevalidation,
} from "./preference-revalidation";
import {
  projectRecapPendingTerminalOutcome,
  reconcileRecapPendingTerminalOutcomes,
} from "./recap-terminal";
import {
  prepareTelegramAlertJobCounterReconciliation,
  prepareTelegramJobTargetFinalDeliveryProjection,
  reconcileTelegramJobTargetFinalDeliveryFromPending,
  recordTelegramJobTargetFinalDelivery,
  resolveTelegramJobTargetIdentityForPending,
} from "../telegram-alert-job-target-outcomes";
import {
  claimTelegramTransportPermit,
  readTelegramDeliveryPause,
  recordTelegramTransportOutcomes as recordTelegramBotWideTransportOutcomes,
  telegramDeliveryPauseSkip,
  telegramTransportPermitSkip,
  type TelegramTransportPermit,
} from "../../lib/telegram-transport-control";
import { migrateTelegramChatId } from "../../api/telegram-store/forget";

export const PENDING_CLAIM_TTL_SEC = 10 * 60;
const PENDING_WAVE_FINALIZATION_RESERVE_MS = 15_000;
const DEFAULT_RETRY_DELAY_SEC = PENDING_BACKOFF_SCHEDULE_SEC[0];
const PREFERENCE_REVALIDATION_RETRY_SEC = 5 * 60;

interface PendingDrainOptions {
  maxPriority?: number | null;
  softDeadlineAtMs?: number | null;
  markTelegramDeliveryStarted?: () => void;
}

function isPendingRowSnoozed(row: PendingAlertRow, nowSec: number): boolean {
  return row.source_type !== "personalized_recap" &&
    row.alert_snooze_until_ts != null && row.alert_snooze_until_ts > nowSec;
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

function buildPendingPreSendSkip(): PreSendBatchResult {
  return {
    ok: false,
    blocked: false,
    retryable: true,
    permanentFailure: false,
    statusCode: null,
    errorClass: "unknown",
    delivery: "retryable_failure",
    retryAfterSec: null,
    skippedReason: "pre_send",
  };
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

function pendingDeadLetterSnapshot(
  row: PendingAlertRow,
  claim: PendingDeliveryClaim | undefined,
  nowSec: number,
  lastErrorClass: string | null,
): DeadLetterPendingRow {
  if (!claim) return { ...row, last_error_class: lastErrorClass };
  return {
    ...row,
    last_error_class: lastErrorClass,
    delivery_state: "sending",
    delivery_owner: claim.owner,
    delivery_generation: claim.generation,
    delivery_started_at: nowSec,
    delivery_claim_expires_at: nowSec + PENDING_CLAIM_TTL_SEC,
  };
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
              p.source_event_id, p.alert_scope_json, p.preference_generation,
              p.markup_policy_json, p.delivery_state, p.delivery_owner,
              p.delivery_generation, p.delivery_started_at, p.delivery_completed_at,
              p.delivery_claim_expires_at,
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

  return (rows.results ?? []).map((row) => ({
    ...row,
    delivery_state: row.delivery_state ?? "pending",
    delivery_owner: row.delivery_owner ?? null,
    delivery_generation: Number.isSafeInteger(row.delivery_generation) ? row.delivery_generation : 0,
    delivery_started_at: row.delivery_started_at ?? null,
    delivery_completed_at: row.delivery_completed_at ?? null,
    delivery_claim_expires_at: row.delivery_claim_expires_at ?? null,
  }));
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

interface PendingSendingFence {
  id: number;
  validatedPreferenceGeneration: number | null;
  deliveryGeneration: number;
}

async function markPendingRowsSending(
  db: D1Database,
  rows: readonly PendingSendingFence[],
  owner: string,
  nowSec: number,
): Promise<Map<number, PendingDeliveryClaim>> {
  if (rows.length === 0) return new Map();
  const claimExpiresAt = nowSec + PENDING_CLAIM_TTL_SEC;
  const results = await db.batch(rows.map((row) =>
    db
      .prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = 'sending',
                delivery_started_at = COALESCE(delivery_started_at, ?),
                delivery_owner = ?,
                delivery_generation = delivery_generation + 1,
                delivery_claim_expires_at = ?,
                updated_at = ?
          WHERE id = ?
            AND processing_owner = ?
            AND delivery_state = 'pending'
            AND delivery_generation = ?
            AND (
              ? IS NULL
              OR EXISTS (
                SELECT 1
                  FROM telegram_subscribers subscriber
                 WHERE subscriber.chat_id = telegram_pending_alerts.chat_id
                   AND subscriber.preference_generation = ?
              )
            )`,
      )
      .bind(
        nowSec,
        owner,
        claimExpiresAt,
        nowSec,
        row.id,
        owner,
        row.deliveryGeneration,
        row.validatedPreferenceGeneration,
        row.validatedPreferenceGeneration,
      ),
  ));
  const claims = new Map<number, PendingDeliveryClaim>();
  for (const [index, result] of results.entries()) {
    const row = rows[index];
    if (row && Number(result.meta?.changes ?? 0) === 1) {
      claims.set(row.id, { id: row.id, owner, generation: row.deliveryGeneration + 1 });
    }
  }
  return claims;
}

async function markSentPendingAlerts(
  db: D1Database,
  outcomes: ReadonlyArray<{ claim: PendingDeliveryClaim; row: PendingAlertRow }>,
  nowSec: number,
): Promise<void> {
  if (outcomes.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  const counterGuards = new Map<string, { targetKey: string }>();
  for (const { claim, row } of outcomes) {
    const identity = row.dedupe_key && row.source_event_id
      ? await resolveTelegramJobTargetIdentityForPending(db, {
        pendingDedupeKey: row.dedupe_key,
        sourceEventId: row.source_event_id,
      })
      : null;
    const targetGuardSql = identity
      ? ` AND EXISTS (
            SELECT 1
              FROM telegram_alert_job_targets target
             WHERE target.job_id = ?
               AND target.target_key = ?
               AND target.pending_dedupe_key = ?
               AND target.source_event_id = ?
               AND (target.final_delivery_state IS NULL OR target.final_delivery_state = 'accepted')
          )`
      : "";
    const targetGuardBinds = identity
      ? [identity.jobId, identity.targetKey, identity.pendingDedupeKey, identity.sourceEventId]
      : [];
    statements.push(
      db.prepare(
          `UPDATE telegram_pending_alerts
              SET delivery_state = 'sent',
                  delivery_completed_at = ?,
                  delivery_claim_expires_at = NULL,
                  updated_at = ?
            WHERE id = ?
              AND processing_owner = ?
              AND delivery_state = 'sending'
              AND delivery_owner = ?
              AND delivery_generation = ?
              ${targetGuardSql}`,
        )
        .bind(
          nowSec,
          nowSec,
          claim.id,
          claim.owner,
          claim.owner,
          claim.generation,
          ...targetGuardBinds,
        ),
    );
    if (identity) {
      statements.push(prepareTelegramJobTargetFinalDeliveryProjection(
        db,
        identity,
        { state: "accepted", at: nowSec },
        {
          pendingGuard: {
            sql: `EXISTS (
              SELECT 1
                FROM telegram_pending_alerts pending
               WHERE pending.id = ?
                 AND pending.delivery_state = 'sent'
                 AND pending.delivery_owner = ?
                 AND pending.delivery_generation = ?
            )`,
            binds: [claim.id, claim.owner, claim.generation],
          },
        },
      ));
      if (!counterGuards.has(identity.jobId)) {
        counterGuards.set(identity.jobId, { targetKey: identity.targetKey });
      }
    }
  }
  for (const [jobId, guard] of counterGuards) {
    statements.push(prepareTelegramAlertJobCounterReconciliation(db, jobId, nowSec, {
      targetKey: guard.targetKey,
      finalDeliveryState: "accepted",
    }));
  }
  const changed = await executeAtomicBatch(db, statements);
  if (changed !== statements.length) {
    throw new Error(`Telegram sent-state persistence was not confirmed (${changed}/${statements.length})`);
  }
  for (const { row } of outcomes) {
    await projectRecapPendingTerminalOutcome(db, row, "accepted", nowSec);
  }
}

interface StalePendingSendingRow {
  id: number;
  delivery_owner: string | null;
  delivery_generation: number;
  source_type: string | null;
  source_event_id: string | null;
}

/** Expired post-effect claims are terminal ambiguity, never retry candidates. */
export async function reconcileStalePendingSending(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const candidates = await db
    .prepare(
      `SELECT id, delivery_owner, delivery_generation, source_type, source_event_id
         FROM telegram_pending_alerts
        WHERE delivery_state = 'sending'
          AND COALESCE(
                delivery_claim_expires_at,
                processing_expires_at,
                delivery_started_at + ?,
                created_at + ?
              ) <= ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .bind(PENDING_CLAIM_TTL_SEC, PENDING_CLAIM_TTL_SEC, nowSec, PENDING_DELETE_CHUNK_SIZE)
    .all<StalePendingSendingRow>();
  const rows = candidates.results ?? [];
  if (rows.length === 0) return 0;
  const changed = await batchExecute(db, rows.map((row) => db
    .prepare(
      `UPDATE telegram_pending_alerts
          SET delivery_state = 'execution_unknown',
              delivery_completed_at = COALESCE(delivery_completed_at, ?),
              delivery_claim_expires_at = NULL,
              last_error_class = COALESCE(last_error_class, 'pending_effect_owner_lost'),
              processing_owner = NULL,
              processing_started_at = NULL,
              processing_expires_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND delivery_state = 'sending'
          AND delivery_owner IS ?
          AND delivery_generation = ?
          AND COALESCE(
                delivery_claim_expires_at,
                processing_expires_at,
                delivery_started_at + ?,
                created_at + ?
              ) <= ?`,
    )
    .bind(
      nowSec,
      nowSec,
      row.id,
      row.delivery_owner,
      row.delivery_generation,
      PENDING_CLAIM_TTL_SEC,
      PENDING_CLAIM_TTL_SEC,
      nowSec,
    )));
  if (changed > 0) {
    await reconcileTelegramJobTargetFinalDeliveryFromPending(db, nowSec);
    await reconcileRecapPendingTerminalOutcomes(db, nowSec);
  }
  return changed;
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
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to delete sent pending alerts",
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
    const finalState = group.reason === "preference_changed" ? "cancelled" : "failed";
    for (const row of group.rows) {
      if (!row.dedupe_key || !row.source_event_id) continue;
      await recordTelegramJobTargetFinalDelivery(
        db,
        { pendingDedupeKey: row.dedupe_key, sourceEventId: row.source_event_id },
        { state: finalState, at: nowSec, error: row.last_error_class ?? group.reason },
      );
    }
    const recapOutcome = group.reason === "preference_changed"
      ? "cancelled"
      : "failed_permanent";
    for (const row of group.rows) {
      await projectRecapPendingTerminalOutcome(
        db,
        row,
        recapOutcome,
        nowSec,
        row.last_error_class ?? group.reason,
      );
    }
    const fencedRows = group.rows.filter((row) =>
      row.delivery_state === "sending" && row.delivery_owner != null && row.delivery_generation != null
    );
    const unfencedRows = group.rows.filter((row) => !fencedRows.includes(row));
    if (fencedRows.length > 0) {
      const deleted = await batchExecute(db, fencedRows.map((row) => db
        .prepare(
          `DELETE FROM telegram_pending_alerts
            WHERE id = ?
              AND delivery_state = 'sending'
              AND delivery_owner = ?
              AND delivery_generation = ?`,
        )
        .bind(row.id, row.delivery_owner, row.delivery_generation)));
      if (deleted !== fencedRows.length) {
        throw new Error(`Telegram terminal pending ownership changed (${deleted}/${fencedRows.length})`);
      }
    }
    await deletePendingAlertsByIds(db, unfencedRows.map((row) => row.id));
  }
}

async function persistPendingDeferrals(
  db: D1Database,
  deferUpdates: readonly PendingDeferUpdate[],
  processingOwner: string,
  nowSec: number,
): Promise<void> {
  if (deferUpdates.length === 0) return;
  const changed = await batchExecute(db, deferUpdates.map((update) => {
    if (update.deliveryClaim) {
      return db.prepare(
        `UPDATE telegram_pending_alerts
            SET not_before_at = ?,
                last_error_class = COALESCE(?, last_error_class),
                updated_at = ?,
                delivery_state = 'pending',
                delivery_owner = NULL,
                delivery_started_at = NULL,
                delivery_completed_at = NULL,
                delivery_claim_expires_at = NULL,
                processing_owner = NULL,
                processing_started_at = NULL,
                processing_expires_at = NULL
          WHERE id = ?
            AND delivery_state = 'sending'
            AND delivery_owner = ?
            AND delivery_generation = ?`,
      )
        .bind(
          update.notBeforeAt,
          update.reason ?? null,
          nowSec,
          update.id,
          update.deliveryClaim.owner,
          update.deliveryClaim.generation,
        );
    }
    return db.prepare(
      `UPDATE telegram_pending_alerts
          SET not_before_at = ?,
              last_error_class = COALESCE(?, last_error_class),
              updated_at = ?,
              processing_owner = NULL,
              processing_started_at = NULL,
              processing_expires_at = NULL
        WHERE id = ?
          AND delivery_state = 'pending'
          AND processing_owner = ?`,
    ).bind(update.notBeforeAt, update.reason ?? null, nowSec, update.id, processingOwner);
  }));
  if (changed !== deferUpdates.length) {
    throw new Error(`Telegram pending deferral ownership changed (${changed}/${deferUpdates.length})`);
  }
}

async function persistPendingRetries(
  db: D1Database,
  retryUpdates: readonly PendingRetryUpdate[],
  nowSec: number,
): Promise<void> {
  if (retryUpdates.length === 0) return;
  const changed = await batchExecute(db, retryUpdates.map((update) => {
    return db
      .prepare(
        `UPDATE telegram_pending_alerts
            SET attempts = attempts + 1,
                delivery_state = 'pending',
                delivery_owner = NULL,
                delivery_started_at = NULL,
                delivery_completed_at = NULL,
                delivery_claim_expires_at = NULL,
                not_before_at = ?,
                last_error_class = ?,
                retry_after_sec = ?,
                updated_at = ?,
                processing_owner = NULL,
                processing_started_at = NULL,
                processing_expires_at = NULL
          WHERE id = ?
            AND delivery_state = 'sending'
            AND delivery_owner = ?
            AND delivery_generation = ?`,
      )
      .bind(
        update.notBeforeAt,
        update.errorClass,
        update.retryAfterSec,
        nowSec,
        update.id,
        update.owner,
        update.generation,
      );
  }));
  if (changed !== retryUpdates.length) {
    throw new Error(`Telegram pending retry ownership changed (${changed}/${retryUpdates.length})`);
  }
}

async function markPendingExecutionUnknown(
  db: D1Database,
  outcomes: ReadonlyArray<{
    claim: PendingDeliveryClaim;
    row: PendingAlertRow;
    errorClass: string | null;
  }>,
  nowSec: number,
): Promise<void> {
  if (outcomes.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  const counterGuards = new Map<string, { targetKey: string }>();
  for (const { claim, row, errorClass } of outcomes) {
    const identity = row.dedupe_key && row.source_event_id
      ? await resolveTelegramJobTargetIdentityForPending(db, {
        pendingDedupeKey: row.dedupe_key,
        sourceEventId: row.source_event_id,
      })
      : null;
    const targetGuardSql = identity
      ? ` AND EXISTS (
            SELECT 1
              FROM telegram_alert_job_targets target
             WHERE target.job_id = ?
               AND target.target_key = ?
               AND target.pending_dedupe_key = ?
               AND target.source_event_id = ?
               AND (
                 target.final_delivery_state IS NULL
                 OR target.final_delivery_state = 'execution_unknown'
               )
          )`
      : "";
    const targetGuardBinds = identity
      ? [identity.jobId, identity.targetKey, identity.pendingDedupeKey, identity.sourceEventId]
      : [];
    statements.push(
      db.prepare(
          `UPDATE telegram_pending_alerts
              SET delivery_state = 'execution_unknown',
                  delivery_completed_at = ?,
                  delivery_claim_expires_at = NULL,
                  last_error_class = COALESCE(?, 'execution_unknown'),
                  processing_owner = NULL,
                  processing_started_at = NULL,
                  processing_expires_at = NULL,
                  updated_at = ?
            WHERE id = ?
              AND delivery_state = 'sending'
              AND delivery_owner = ?
              AND delivery_generation = ?
              ${targetGuardSql}`,
        )
        .bind(
          nowSec,
          errorClass,
          nowSec,
          claim.id,
          claim.owner,
          claim.generation,
          ...targetGuardBinds,
        ),
    );
    if (identity) {
      statements.push(prepareTelegramJobTargetFinalDeliveryProjection(
        db,
        identity,
        { state: "execution_unknown", at: nowSec, error: errorClass },
        {
          pendingGuard: {
            sql: `EXISTS (
              SELECT 1
                FROM telegram_pending_alerts pending
               WHERE pending.id = ?
                 AND pending.delivery_state = 'execution_unknown'
                 AND pending.delivery_owner = ?
                 AND pending.delivery_generation = ?
            )`,
            binds: [claim.id, claim.owner, claim.generation],
          },
        },
      ));
      if (!counterGuards.has(identity.jobId)) {
        counterGuards.set(identity.jobId, { targetKey: identity.targetKey });
      }
    }
  }
  for (const [jobId, guard] of counterGuards) {
    statements.push(prepareTelegramAlertJobCounterReconciliation(db, jobId, nowSec, {
      targetKey: guard.targetKey,
      finalDeliveryState: "execution_unknown",
    }));
  }
  const changed = await executeAtomicBatch(db, statements);
  if (changed !== statements.length) {
    throw new Error(`Telegram pending ambiguity state was not confirmed (${changed}/${statements.length})`);
  }
  for (const { row, errorClass } of outcomes) {
    await projectRecapPendingTerminalOutcome(db, row, "execution_unknown", nowSec, errorClass);
  }
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
  | { kind: "execution-unknown"; errorClass: string }
  | { kind: "blocked"; errorClass: string }
  | {
      kind: "retry";
      retryUpdate: Omit<PendingRetryUpdate, "owner" | "generation">;
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
  if (result.errorClass === "timeout" || result.errorClass === "network" || result.errorClass === "unknown") {
    return { kind: "execution-unknown", errorClass: result.errorClass };
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

interface CheckpointedPendingWaveOutcome {
  row: PendingAlertRow;
  claim: PendingDeliveryClaim;
  classification: PendingResultClassification;
  completedAt: number;
}

async function checkpointAttemptedPendingWave(
  db: D1Database,
  outcomes: readonly CheckpointedPendingWaveOutcome[],
  completedAt: number,
): Promise<void> {
  const sentOutcomes: Array<{ claim: PendingDeliveryClaim; row: PendingAlertRow }> = [];
  const executionUnknownOutcomes: Array<{
    claim: PendingDeliveryClaim;
    row: PendingAlertRow;
    errorClass: string | null;
  }> = [];
  const retryUpdates: PendingRetryUpdate[] = [];
  const blockedRows: DeadLetterPendingRow[] = [];
  const permanentRows: DeadLetterPendingRow[] = [];
  const maxAttemptRows: DeadLetterPendingRow[] = [];
  let globalBackoffAt: number | null = null;

  for (const outcome of outcomes) {
    const { classification, claim, row } = outcome;
    switch (classification.kind) {
      case "sent":
        sentOutcomes.push({ claim, row });
        break;
      case "execution-unknown":
        executionUnknownOutcomes.push({ claim, row, errorClass: classification.errorClass });
        break;
      case "retry":
        retryUpdates.push({ ...classification.retryUpdate, ...claim });
        break;
      case "blocked":
        blockedRows.push(pendingDeadLetterSnapshot(row, claim, completedAt, classification.errorClass));
        break;
      case "dropped-max-attempts":
        maxAttemptRows.push(pendingDeadLetterSnapshot(row, claim, completedAt, classification.errorClass));
        break;
      case "dropped-permanent":
        permanentRows.push(pendingDeadLetterSnapshot(row, claim, completedAt, classification.errorClass));
        break;
    }

    if (classification.kind === "retry" && classification.rateLimit?.scope === "global") {
      globalBackoffAt = Math.max(globalBackoffAt ?? 0, classification.rateLimit.notBeforeAt);
    }
  }

  await markSentPendingAlerts(db, sentOutcomes, completedAt);
  await markPendingExecutionUnknown(db, executionUnknownOutcomes, completedAt);
  await persistPendingRetries(db, retryUpdates, completedAt);
  if (globalBackoffAt != null) await setTelegramGlobalBackoff(db, globalBackoffAt);
  await deadLetterAndDeleteTerminalPendingGroups(
    db,
    [
      { rows: blockedRows, reason: "blocked_disabled" },
      { rows: permanentRows, reason: "permanent_failure" },
      { rows: maxAttemptRows, reason: "max_attempts" },
    ],
    completedAt,
  );
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
  await reconcileStalePendingSending(db, nowSec);
  await reconcileTelegramJobTargetFinalDeliveryFromPending(db, nowSec);
  await reconcileTerminalTargetRows(db, nowSec);
  await reconcileRecapPendingTerminalOutcomes(db, nowSec);
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
  const transportOwner = `pending-transport:${claimOwner}`;
  let nextTransportPermit: TelegramTransportPermit | null = await claimTelegramTransportPermit(db, {
    mode: "pending",
    owner: transportOwner,
    nowSec,
    requestedDistinctChats: Math.min(SEND_BATCH_SIZE, limit),
  });
  if (!nextTransportPermit.allowed) {
    return {
      ...emptyDrainResult(),
      retryAfterSec: nextTransportPermit.deferUntil == null
        ? null
        : Math.max(1, nextTransportPermit.deferUntil - nowSec),
      notBeforeAt: nextTransportPermit.deferUntil,
    };
  }
  const claimLimit = nextTransportPermit.reason === "half_open_probe"
    ? Math.min(limit, nextTransportPermit.maxDistinctChats)
    : limit;
  const pending = await claimDuePendingRows(db, nowSec, claimLimit, claimOwner, maxPriority);
  if (pending.length === 0) {
    await recordTelegramBotWideTransportOutcomes(db, nextTransportPermit, [], nowSec);
    return emptyDrainResult();
  }

  let attempted = 0;
  let deferred = 0;
  let blockedCleanedUp = 0;
  let blockedCleanupFailed = 0;
  const sentClaimsToDelete: Array<{ claim: PendingDeliveryClaim; row: PendingAlertRow }> = [];
  const blockedRowsToDelete: DeadLetterPendingRow[] = [];
  const permanentRowsToDelete: DeadLetterPendingRow[] = [];
  const maxAttemptRowsToDelete: DeadLetterPendingRow[] = [];
  const preferenceRowsToDelete: DeadLetterPendingRow[] = [];
  const completedIds = new Set<number>();
  const retryUpdates: PendingRetryUpdate[] = [];
  const deferUpdates: PendingDeferUpdate[] = [];
  const executionUnknownOutcomes: Array<{
    claim: PendingDeliveryClaim;
    row: PendingAlertRow;
    errorClass: string | null;
  }> = [];
  // Per-result outcome kinds, tallied in one pass after the send loop so each
  // counter derives from exactly one source of truth.
  const outcomeKinds: PendingResultClassification["kind"][] = [];
  let rateLimited = false;
  let rateLimitRetryAfterSec: number | null = null;
  let rateLimitNotBeforeAt: number | null = null;
  const deliveryDiagnostics: PendingDeliveryDiagnostic[] = [];
  const targetStatusUpdates: TelegramAlertTargetStatusUpdate[] = [];
  const targetCancellations: TelegramAlertTargetCancellation[] = [];
  const pendingById = new Map(pending.map((row) => [row.id, row] as const));
  const blockedChatsThisLoop = new Set<string>();
  const chatsToResetOnSuccess = new Set<string>();
  const disabledChatIds = new Set<string>();
  const migratedChatIds = new Map<string, string>();
  const sendingClaims = new Map<number, PendingDeliveryClaim>();
  const checkpointedAttemptedOutcomes = new Map<number, CheckpointedPendingWaveOutcome>();
  const softDeadlineAtMs = Number.isFinite(options.softDeadlineAtMs)
    ? options.softDeadlineAtMs
    : null;
  const sendDeadlineAtMs = softDeadlineAtMs == null
    ? null
    : softDeadlineAtMs - PENDING_WAVE_FINALIZATION_RESERVE_MS;
  let waveTransportPermit: TelegramTransportPermit | null = null;

  let revalidations: PendingPreferenceRevalidation[];
  try {
    revalidations = await revalidatePendingAlertPreferences(db, pending, nowSec);
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to revalidate pending Telegram preferences",
      action: "preference-revalidation",
      module: "telegram-pending-drain",
      rowCount: pending.length,
    });
    revalidations = pending.map((row) => ({
      kind: "defer" as const,
      row,
      notBeforeAt: nowSec + PREFERENCE_REVALIDATION_RETRY_SEC,
      reason: "preference_revalidation_failed",
    }));
  }

  const sendableRows: Array<{
    chatId: string;
    row: PendingAlertRow;
    message: BatchMessage;
    disableWebPagePreview: boolean;
    validatedPreferenceGeneration: number | null;
  }> = [];
  for (const outcome of revalidations) {
    const row = outcome.row;
    if (outcome.kind === "cancel") {
      preferenceRowsToDelete.push({ ...row, last_error_class: outcome.reason });
      if (row.dedupe_key) {
        targetCancellations.push({
          targetKey: row.dedupe_key,
          at: nowSec,
          reason: outcome.reason,
        });
      }
      completedIds.add(row.id);
      continue;
    }
    if (outcome.kind === "defer") {
      deferred++;
      deferUpdates.push({
        id: row.id,
        notBeforeAt: outcome.notBeforeAt,
        reason: outcome.reason,
      });
      appendPendingTargetStatus(targetStatusUpdates, row, "queued", nowSec, outcome.reason);
      completedIds.add(row.id);
      continue;
    }
    if (isPendingRowSnoozed(row, nowSec)) {
      deferred++;
      deferUpdates.push({
        id: row.id,
        notBeforeAt: Math.max(row.alert_snooze_until_ts ?? 0, nowSec + DEFAULT_RETRY_DELAY_SEC),
        reason: "preference_snoozed",
      });
      appendPendingTargetStatus(targetStatusUpdates, row, "queued", nowSec);
      completedIds.add(row.id);
      continue;
    }
    sendableRows.push({
      chatId: row.chat_id,
      row,
      validatedPreferenceGeneration: outcome.validatedPreferenceGeneration,
      disableWebPagePreview: outcome.markupPolicy?.disableWebPagePreview ?? true,
      message: {
        chatId: row.chat_id,
        html: row.message_html,
        disableNotification: shouldSilencePendingRow(row, nowSec),
        replyMarkup: outcome.markupPolicy?.replyMarkup ?? SNOOZE_REPLY_MARKUP,
        ...(outcome.markupPolicy?.linkPreviewOptions
          ? { linkPreviewOptions: outcome.markupPolicy.linkPreviewOptions }
          : {}),
        ...(row.chunk_index != null ? { chunkIndex: row.chunk_index } : {}),
        ...(row.alert_type != null ? { alertType: row.alert_type } : {}),
      },
    });
  }

  const scheduledResults = await schedulePerChatBatches(
    sendableRows,
    SEND_BATCH_SIZE,
    ({ row, message, disableWebPagePreview }) =>
      sendToChat(row.chat_id, row.message_html, botToken, {
        disableWebPagePreview,
        linkPreviewOptions: message.linkPreviewOptions,
        disableNotification: message.disableNotification,
        replyMarkup: message.replyMarkup,
        signal,
      }),
    {
      signal,
      softDeadlineAtMs: sendDeadlineAtMs,
      beforeSendBatch: async (entries) => {
        const permitNowSec = Math.floor(Date.now() / 1000);
        waveTransportPermit = nextTransportPermit ?? await claimTelegramTransportPermit(db, {
          mode: "pending",
          owner: transportOwner,
          nowSec: permitNowSec,
          requestedDistinctChats: entries.length,
        });
        nextTransportPermit = null;
        if (!waveTransportPermit.allowed) {
          const skipped = new Map<number, PreSendBatchResult>();
          const skip = telegramTransportPermitSkip(waveTransportPermit, permitNowSec);
          for (const entry of entries) skipped.set(entry.index, skip);
          return skipped;
        }
        const adminEntries = entries.filter((entry) =>
          entry.item.row.source_type === "admin_broadcast" || entry.item.row.source_type === "admin_replay"
        );
        const adminPause = adminEntries.length > 0
          ? await readTelegramDeliveryPause(db, "admin", permitNowSec)
          : null;
        const pausedAdminIndexes = new Set(
          adminPause?.active ? adminEntries.map((entry) => entry.index) : [],
        );
        const marked = await markPendingRowsSending(
          db,
          entries.filter((entry) => !pausedAdminIndexes.has(entry.index)).map(({ item }) => ({
            id: item.row.id,
            validatedPreferenceGeneration: item.validatedPreferenceGeneration,
            deliveryGeneration: item.row.delivery_generation,
          })),
          claimOwner,
          Math.floor(Date.now() / 1000),
        );
        for (const [id, claim] of marked) sendingClaims.set(id, claim);
        if (marked.size > 0) options.markTelegramDeliveryStarted?.();
        if (marked.size === entries.length) return;
        const skipped = new Map<number, PreSendBatchResult>();
        for (const entry of entries) {
          if (adminPause?.active && pausedAdminIndexes.has(entry.index)) {
            skipped.set(entry.index, telegramDeliveryPauseSkip(adminPause, permitNowSec));
            continue;
          }
          if (!marked.has(entry.item.row.id)) {
            skipped.set(entry.index, buildPendingPreSendSkip());
          }
        }
        return skipped;
      },
      afterSendBatch: async (entries, results) => {
        const completedAt = Math.floor(Date.now() / 1000);
        const waveOutcomes: CheckpointedPendingWaveOutcome[] = [];
        for (const [index, entry] of entries.entries()) {
          const scheduledResult = results[index];
          if (!scheduledResult || scheduledResult.attempted === false) continue;
          const row = entry.item.row;
          const claim = sendingClaims.get(row.id);
          if (!claim) {
            throw new Error(`Telegram pending delivery claim missing after attempted send (${row.id})`);
          }
          const result: PendingSendResult = {
            ...scheduledResult,
            id: row.id,
            chatId: entry.item.chatId,
            attempts: row.attempts,
          };
          waveOutcomes.push({
            row,
            claim,
            classification: classifyPendingSendResult(result, completedAt),
            completedAt,
          });
        }
        await checkpointAttemptedPendingWave(db, waveOutcomes, completedAt);
        for (const outcome of waveOutcomes) {
          checkpointedAttemptedOutcomes.set(outcome.row.id, outcome);
        }

        const transportPermit = waveTransportPermit;
        waveTransportPermit = null;
        if (!transportPermit?.allowed) return;
        const attemptedOutcomes = results
          .filter((result) => result.attempted !== false)
          .map((result) => ({ chatId: result.chatId, result }));
        await recordTelegramBotWideTransportOutcomes(
          db,
          transportPermit,
          attemptedOutcomes,
          completedAt,
        );
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
    const deliveryClaim = sendingClaims.get(result.id);
    const checkpointedOutcome = checkpointedAttemptedOutcomes.get(result.id);
    const outcomeAt = checkpointedOutcome?.completedAt ?? Math.floor(Date.now() / 1000);
    if (result.errorClass === "chat_migrated" && result.migrateToChatId) {
      migratedChatIds.set(result.chatId, result.migrateToChatId);
    }
    const pushTargetStatus = (
      status: TelegramAlertTargetStatusUpdate["status"],
      errorClass?: string | null,
    ) => appendPendingTargetStatus(targetStatusUpdates, pendingRow, status, outcomeAt, errorClass);

    if (result.attempted === false) {
      if (result.skippedReason === "transport_control" || result.skippedReason === "delivery_mode_pause") {
        continue;
      }
      if (result.skippedReason === "pre_send") {
        deferred++;
        deferUpdates.push({
          id: result.id,
          notBeforeAt: nowSec + DEFAULT_RETRY_DELAY_SEC,
          reason: "preference_generation_changed",
        });
        pushTargetStatus("queued", "preference_generation_changed");
        completedIds.add(result.id);
        continue;
      }
      if (result.skippedReason === "predecessor_failure" && result.retryable) {
        const notBeforeAt =
          predecessorRetryAtByChat.get(result.chatId) ??
          nowSec + pendingBackoffSec(result.attempts, result.retryAfterSec);
        deferred++;
        deferUpdates.push({ id: result.id, notBeforeAt, ...(deliveryClaim ? { deliveryClaim } : {}) });
        pushTargetStatus("queued", result.errorClass);
        completedIds.add(result.id);
        continue;
      }
      if (result.skippedReason !== "predecessor_failure") {
        continue;
      }
    } else {
      if (!deliveryClaim) {
        throw new Error(`Telegram pending delivery claim missing after attempted send (${result.id})`);
      }
      attempted++;
      deliveryDiagnostics.push(
        result.ok
          ? { chatId: result.chatId, ok: true }
          : { chatId: result.chatId, ok: false, errorClass: result.errorClass },
      );
    }

    const classification = checkpointedOutcome?.classification ?? classifyPendingSendResult(result, outcomeAt);
    outcomeKinds.push(classification.kind);
    completedIds.add(result.id);

    switch (classification.kind) {
      case "sent": {
        if (!deliveryClaim) throw new Error(`Telegram sent result lost delivery ownership (${result.id})`);
        if (!pendingRow) throw new Error(`Telegram sent result lost pending row (${result.id})`);
        sentClaimsToDelete.push({ claim: deliveryClaim, row: pendingRow });
        pushTargetStatus("sent");
        chatsToResetOnSuccess.add(result.chatId);
        break;
      }
      case "execution-unknown": {
        if (!deliveryClaim) throw new Error(`Telegram ambiguous result lost delivery ownership (${result.id})`);
        if (!pendingRow) throw new Error(`Telegram ambiguous result lost pending row (${result.id})`);
        if (!checkpointedOutcome) {
          executionUnknownOutcomes.push({
            claim: deliveryClaim,
            row: pendingRow,
            errorClass: classification.errorClass,
          });
        }
        break;
      }
      case "blocked": {
        if (pendingRow && !checkpointedOutcome) blockedRowsToDelete.push(pendingDeadLetterSnapshot(
          pendingRow,
          deliveryClaim,
          outcomeAt,
          result.errorClass ?? pendingRow.last_error_class,
        ));
        pushTargetStatus("failed", classification.errorClass);
        const blockedCascade = await handleBlockedChat(db, result.chatId, outcomeAt, blockedChatsThisLoop);
        if (blockedCascade.disabled) {
          blockedCleanedUp++;
          disabledChatIds.add(result.chatId);
        } else if (blockedCascade.failed) {
          blockedCleanupFailed++;
        }
        break;
      }
      case "retry": {
        if (!deliveryClaim) throw new Error(`Telegram retry result lost delivery ownership (${result.id})`);
        if (!checkpointedOutcome) retryUpdates.push({ ...classification.retryUpdate, ...deliveryClaim });
        pushTargetStatus("queued", classification.targetErrorClass);
        if (classification.retryUpdate.notBeforeAt != null) {
          predecessorRetryAtByChat.set(result.chatId, classification.retryUpdate.notBeforeAt);
        }
        if (classification.rateLimit) {
          rateLimited = true;
          rateLimitRetryAfterSec = classification.rateLimit.retryAfterSec;
          rateLimitNotBeforeAt = Math.max(rateLimitNotBeforeAt ?? 0, classification.rateLimit.notBeforeAt);
          if (classification.rateLimit.scope === "global" && !checkpointedOutcome) {
            await setTelegramGlobalBackoff(db, rateLimitNotBeforeAt);
          }
        }
        break;
      }
      case "dropped-max-attempts": {
        if (pendingRow && !checkpointedOutcome) maxAttemptRowsToDelete.push(pendingDeadLetterSnapshot(
          pendingRow,
          deliveryClaim,
          outcomeAt,
          result.errorClass ?? pendingRow.last_error_class,
        ));
        pushTargetStatus("failed", classification.errorClass);
        break;
      }
      case "dropped-permanent": {
        if (pendingRow && !checkpointedOutcome) permanentRowsToDelete.push(pendingDeadLetterSnapshot(
          pendingRow,
          deliveryClaim,
          outcomeAt,
          result.errorClass ?? pendingRow.last_error_class,
        ));
        pushTargetStatus("failed", classification.errorClass);
        break;
      }
    }
  }

  // Single-pass tally: every counter derives from the recorded outcome kinds.
  const sent = outcomeKinds.filter((kind) => kind === "sent").length;
  const acceptedChats = new Set(sentClaimsToDelete.map(({ row }) => row.chat_id)).size;
  const blocked = outcomeKinds.filter((kind) => kind === "blocked").length;
  const retryQueued = outcomeKinds.filter((kind) => kind === "retry").length;
  const executionUnknown = outcomeKinds.filter((kind) => kind === "execution-unknown").length;
  const droppedMaxAttemptsFallback = outcomeKinds.filter((kind) => kind === "dropped-max-attempts").length;
  const droppedPermanentFailure = outcomeKinds.filter((kind) => kind === "dropped-permanent").length;
  const dropped = droppedMaxAttemptsFallback + droppedPermanentFailure + preferenceRowsToDelete.length;

  await flushChatSuccessResets(db, chatsToResetOnSuccess);
  await markPendingExecutionUnknown(db, executionUnknownOutcomes, nowSec);
  await recordPendingDrainTelemetry(db, deliveryDiagnostics, targetStatusUpdates);
  await recordTelegramAlertTargetCancellations(db, targetCancellations);

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
    { rows: preferenceRowsToDelete, reason: "preference_changed" },
  ];
  await deleteSentPendingAlerts(db, sentClaimsToDelete.map(({ claim }) => claim.id));
  await deadLetterAndDeleteTerminalPendingGroups(db, terminalDeleteGroups, nowSec);
  await persistPendingDeferrals(db, deferUpdates, claimOwner, nowSec);
  await persistPendingRetries(db, retryUpdates, nowSec);
  for (const [oldChatId, newChatId] of migratedChatIds) {
    await migrateTelegramChatId(db, oldChatId, newChatId);
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
    acceptedChats,
    blocked,
    blockedCleanedUp,
    blockedCleanupFailed,
    retryQueued,
    executionUnknown,
    dropped,
    droppedPermanentFailure,
    droppedMaxAttemptsFallback,
    deferred,
    rateLimited,
    retryAfterSec: rateLimitRetryAfterSec,
    notBeforeAt: rateLimitNotBeforeAt,
  };
}
