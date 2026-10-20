import { batchExecute } from "../../../lib/db";
import type { BatchResult } from "../../../telegram/delivery/telegram";
import { PENDING_MAX_ATTEMPTS, PENDING_TTL_SEC, TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX } from "../../../telegram/common/constants";
import { recordTelegramDeliveryOutcomes } from "../../../telegram/store/usage-analytics";
import {
  recordTelegramAlertTargetStatuses,
  type TelegramAlertTargetStatusUpdate,
} from "./telegram-alert-target-status";
import { pendingBackoffSec, setTelegramGlobalBackoff } from "./backoff";
import {
  claimedDeleteByDeliveryClaims,
  settleUnstartedPendingRows,
  deadLetterTerminalPendingRows,
} from "./dead-letter";
import type {
  DeadLetterPendingRow,
  PendingAlertRow,
  PendingDeferUpdate,
  PendingDeliveryClaim,
  PendingDeliveryDiagnostic,
  PendingRetryUpdate,
  PendingDeadLetterReason,
} from "./types";
import { logTelegramEvent } from "../../../telegram/common/log";
import { recordTelegramJobTargetFinalDelivery } from "./telegram-alert-job-target-outcomes";
import {
  persistPendingTerminalOutcomes,
  preparePendingSendingTransition,
} from "./transitions";

export const PENDING_CLAIM_TTL_SEC = 10 * 60;

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

export async function recordPendingDrainTelemetry(
  db: D1Database,
  deliveryDiagnostics: PendingDeliveryDiagnostic[],
  targetStatusUpdates: TelegramAlertTargetStatusUpdate[],
): Promise<void> {
  await recordTelegramDeliveryOutcomes(db, deliveryDiagnostics);
  await recordTelegramAlertTargetStatuses(db, targetStatusUpdates);
}

export async function deleteSentPendingAlerts(
  db: D1Database,
  sentClaimsToDelete: readonly PendingDeliveryClaim[],
): Promise<void> {
  if (sentClaimsToDelete.length === 0) return;
  try {
    await claimedDeleteByDeliveryClaims(db, sentClaimsToDelete);
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to delete sent pending alerts",
      action: "delete-sent-pending",
      module: "telegram-pending-drain",
      rowCount: sentClaimsToDelete.length,
    });
  }
}

export async function deadLetterAndDeleteTerminalPendingGroups(
  db: D1Database,
  groups: Array<{ rows: DeadLetterPendingRow[]; reason: PendingDeadLetterReason }>,
  nowSec: number,
  processingOwner: string,
): Promise<void> {
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    const unfencedRows = group.rows.filter((row) => row.delivery_state !== "sending");
    if (unfencedRows.length > 0) {
      await settleUnstartedPendingRows(db, unfencedRows, nowSec, group.reason, processingOwner);
    }
    const attemptedRows = group.rows.filter((row) => row.delivery_state === "sending");
    if (attemptedRows.length === 0) continue;
    const deadLettered = await deadLetterTerminalPendingRows(db, attemptedRows, nowSec, group.reason);
    if (!deadLettered) continue;
    const finalState = group.reason === "preference_changed" ? "cancelled" : "failed";
    for (const row of attemptedRows) {
      if (!row.dedupe_key || !row.source_event_id) continue;
      await recordTelegramJobTargetFinalDelivery(
        db,
        { pendingDedupeKey: row.dedupe_key, sourceEventId: row.source_event_id },
        { state: finalState, at: nowSec, error: row.last_error_class ?? group.reason },
      );
    }
    const fencedRows = attemptedRows.filter((row) =>
      row.delivery_owner != null && row.delivery_generation != null
    );
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
  }
}

export async function persistPendingDeferrals(
  db: D1Database,
  deferUpdates: readonly PendingDeferUpdate[],
  processingOwner: string,
  nowSec: number,
): Promise<void> {
  if (deferUpdates.length === 0) return;
  const changed = await batchExecute(db, deferUpdates.map((update) => {
    if (update.deliveryClaim) {
      return preparePendingSendingTransition(db, update.deliveryClaim, {
        to: "pending",
        notBeforeAt: update.notBeforeAt,
        errorClass: update.reason ?? null,
      }, { updatedAtSec: nowSec });
    }
    return db.prepare(
      `UPDATE telegram_pending_alerts
          SET not_before_at = MAX(COALESCE(not_before_at, 0), ?),
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

/** The Telegram send result enriched with the originating pending row's id/chat/attempts. */
export type PendingSendResult = { id: number; chatId: string; attempts: number } & BatchResult;
type PendingOutcomeCounter =
  | "sent"
  | "executionUnknown"
  | "blocked"
  | "retryQueued"
  | "droppedMaxAttemptsFallback"
  | "droppedPermanentFailure";
type AttemptDeadLetterReason = "blocked_disabled" | "permanent_failure" | "max_attempts";

export interface PendingOutcomeProjection {
  kind: PendingOutcomeCounter;
  row: PendingAlertRow;
  claim: PendingDeliveryClaim | undefined;
  at: number;
  errorClass?: string | null;
  targetStatus: TelegramAlertTargetStatusUpdate["status"] | null;
  retryUpdate?: PendingRetryUpdate;
  rateLimit?: { retryAfterSec: number | null; notBeforeAt: number; scope: "chat" | "global" };
  deadLetter?: { row: DeadLetterPendingRow; reason: AttemptDeadLetterReason };
}

/** Project one result once; checkpointing and later side effects consume the same value. */
export function reducePendingOutcome(
  result: PendingSendResult,
  row: PendingAlertRow,
  claim: PendingDeliveryClaim | undefined,
  at: number,
): PendingOutcomeProjection {
  const base = { row, claim, at };
  const terminal = (
    kind: "blocked" | "droppedMaxAttemptsFallback" | "droppedPermanentFailure",
    errorClass: string,
    reason: AttemptDeadLetterReason,
  ): PendingOutcomeProjection => ({
    ...base,
    kind,
    errorClass,
    targetStatus: "failed",
    deadLetter: {
      row: pendingDeadLetterSnapshot(row, claim, at, claim ? errorClass : result.errorClass ?? row.last_error_class),
      reason,
    },
  });
  if (result.ok) return { ...base, kind: "sent", targetStatus: "sent" };
  if (result.errorClass === "timeout" || result.errorClass === "network" || result.errorClass === "unknown") {
    return { ...base, kind: "executionUnknown", errorClass: result.errorClass, targetStatus: null };
  }
  if (result.blocked) {
    return terminal("blocked", result.errorClass ?? "blocked", "blocked_disabled");
  }
  if (result.retryable && result.attempts < PENDING_MAX_ATTEMPTS) {
    const notBeforeAt = at + pendingBackoffSec(result.attempts, result.retryAfterSec);
    const globalRateLimit = result.errorClass === "rate_limit" && result.rateLimitScope === "global";
    return {
      ...base,
      kind: "retryQueued",
      errorClass: result.errorClass ?? null,
      targetStatus: "queued",
      retryUpdate: claim
        ? {
          retryAfterSec: result.retryAfterSec,
          errorClass: result.errorClass,
          notBeforeAt: globalRateLimit ? null : notBeforeAt,
          ...claim,
        }
        : undefined,
      rateLimit: result.errorClass === "rate_limit"
        ? {
          retryAfterSec: result.retryAfterSec,
          notBeforeAt,
          scope: result.rateLimitScope === "global" ? "global" : "chat",
        }
        : undefined,
    };
  }
  const maxAttempts = result.retryable;
  return {
    ...terminal(
      maxAttempts ? "droppedMaxAttemptsFallback" : "droppedPermanentFailure",
      result.errorClass ?? (maxAttempts ? "max_attempts" : "permanent_failure"),
      maxAttempts ? "max_attempts" : "permanent_failure",
    ),
    ...(result.errorClass === "rate_limit" && result.rateLimitScope !== "global" ? {
      rateLimit: {
        retryAfterSec: result.retryAfterSec,
        notBeforeAt: at + pendingBackoffSec(result.attempts, result.retryAfterSec),
        scope: "chat" as const,
      },
    } : {}),
  };
}

export async function checkpointAttemptedPendingWave(
  db: D1Database,
  outcomes: readonly PendingOutcomeProjection[],
  completedAt: number,
  processingOwner: string,
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
  const globalDeferNotBeforeAtByRow = new Map<number, number>();

  for (const outcome of outcomes) {
    if (outcome.kind === "sent") sentOutcomes.push({ claim: outcome.claim!, row: outcome.row });
    if (outcome.kind === "executionUnknown") {
      executionUnknownOutcomes.push({ claim: outcome.claim!, row: outcome.row, errorClass: outcome.errorClass ?? null });
    }
    if (outcome.retryUpdate) retryUpdates.push(outcome.retryUpdate);
    if (outcome.deadLetter) {
      const target = outcome.deadLetter.reason === "blocked_disabled"
        ? blockedRows
        : outcome.deadLetter.reason === "permanent_failure"
          ? permanentRows
          : maxAttemptRows;
      target.push(outcome.deadLetter.row);
    }
    if (outcome.rateLimit?.scope === "global") {
      globalBackoffAt = Math.max(globalBackoffAt ?? 0, outcome.rateLimit.notBeforeAt);
      globalDeferNotBeforeAtByRow.set(outcome.row.id, outcome.rateLimit.notBeforeAt);
    }
  }

  await persistPendingTerminalOutcomes(db, { outcomes: sentOutcomes, state: "sent", nowSec: completedAt });
  await persistPendingTerminalOutcomes(db, { outcomes: executionUnknownOutcomes, state: "execution_unknown", nowSec: completedAt });
  // Land the durable global gate before the retry rows are written: when the
  // cache write cannot land, the per-row fallback below must carry the defer.
  let globalBackoffDurable = true;
  if (globalBackoffAt != null) {
    globalBackoffDurable = await setTelegramGlobalBackoff(db, globalBackoffAt);
  }
  const chatBackoffs = outcomes.filter((outcome) => outcome.rateLimit?.scope === "chat" && outcome.claim);
  if (retryUpdates.length > 0 || chatBackoffs.length > 0) {
    const backoffStatements = chatBackoffs.flatMap((outcome) => [db.prepare(
      `UPDATE telegram_pending_alerts INDEXED BY idx_telegram_pending_alerts_chat_id
          SET not_before_at = MAX(COALESCE(not_before_at, 0), ?)
        WHERE chat_id = ?
          AND delivery_state = 'pending'
          AND COALESCE(expires_at, created_at + ?) > ?
          AND EXISTS (
            SELECT 1 FROM telegram_pending_alerts attempted
             WHERE attempted.id = ? AND attempted.delivery_state = 'sending'
               AND attempted.delivery_owner = ? AND attempted.delivery_generation = ?
          )`,
    ).bind(
      outcome.rateLimit!.notBeforeAt, outcome.row.chat_id, PENDING_TTL_SEC, completedAt,
      outcome.claim!.id, outcome.claim!.owner, outcome.claim!.generation,
    ), db.prepare(
      `INSERT INTO cache (key, value, updated_at)
       SELECT ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM telegram_pending_alerts attempted
          WHERE attempted.id = ? AND attempted.delivery_state = 'sending'
            AND attempted.delivery_owner = ? AND attempted.delivery_generation = ?
       )
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(MAX(CAST(cache.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT),
         updated_at = MAX(cache.updated_at, excluded.updated_at)`,
    ).bind(
      `${TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX}${outcome.row.chat_id}`,
      String(outcome.rateLimit!.notBeforeAt), completedAt,
      outcome.claim!.id, outcome.claim!.owner, outcome.claim!.generation,
    )]);
    const retryStatements = retryUpdates.map((update) =>
      preparePendingSendingTransition(db, update, {
        to: "pending",
        // A bot-wide rate limit normally defers through the durable global
        // gate alone; without it the row itself must hold not_before_at so
        // the next drain still cannot send early.
        notBeforeAt: update.notBeforeAt == null && !globalBackoffDurable
          ? globalDeferNotBeforeAtByRow.get(update.id) ?? null
          : update.notBeforeAt,
        errorClass: update.errorClass,
        retryAfterSec: update.retryAfterSec,
      }, { updatedAtSec: completedAt }),
    );
    const results = await db.batch([...backoffStatements, ...retryStatements]);
    const changed = results.slice(backoffStatements.length)
      .reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0);
    if (changed !== retryUpdates.length) {
      throw new Error(`Telegram pending retry ownership changed (${changed}/${retryUpdates.length})`);
    }
  }
  await deadLetterAndDeleteTerminalPendingGroups(
    db,
    [
      { rows: blockedRows, reason: "blocked_disabled" },
      { rows: permanentRows, reason: "permanent_failure" },
      { rows: maxAttemptRows, reason: "max_attempts" },
    ],
    completedAt,
    processingOwner,
  );
}
