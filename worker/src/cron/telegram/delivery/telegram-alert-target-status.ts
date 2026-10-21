import { batchExecute } from "../../../lib/db";
import { runWithOverloadRetry } from "../../../lib/d1-overload-retry";
import { TELEGRAM_ALERT_TTL_SEC } from "../../../telegram/common/constants";
import { logTelegramEvent } from "../../../telegram/common/log";
import {
  reconcileTelegramAlertJobCounters,
  type TelegramTargetProjectionGuard,
} from "./telegram-alert-job-target-outcomes";

export interface TelegramAlertTargetStatusUpdate {
  targetKey: string;
  sourceEventId: string;
  status: "queued" | "sent" | "failed" | "expired";
  at: number;
  errorClass?: string | null;
}

export interface TelegramAlertTargetCancellation {
  targetKey: string;
  sourceEventId: string;
  at: number;
  reason: string;
  pendingGuard?: TelegramTargetProjectionGuard;
}

export async function recordTelegramAlertTargetStatuses(
  db: D1Database,
  updates: readonly TelegramAlertTargetStatusUpdate[],
): Promise<void> {
  if (updates.length === 0) return;
  try {
    await batchExecute(db, updates.map((update) => {
      const sentAt = update.status === "sent" ? update.at : null;
      const enqueuedAt = update.status === "queued" ? update.at : null;
      const failedAt = update.status === "failed" || update.status === "expired" ? update.at : null;
      return db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET status = ?,
                  sent_at = COALESCE(sent_at, ?),
                  enqueued_at = COALESCE(enqueued_at, ?),
                  failed_at = COALESCE(failed_at, ?),
                  error_class = COALESCE(?, error_class)
            WHERE pending_dedupe_key = ?
              AND source_event_id = ?
              AND status <> 'sent'
              AND effect_state NOT IN ('sending', 'execution_unknown')`,
        )
        .bind(
          update.status,
          sentAt,
          enqueuedAt,
          failedAt,
          update.errorClass ?? null,
          update.targetKey,
          update.sourceEventId,
        );
    }));
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to update Telegram alert job targets",
      action: "update-alert-job-targets",
      module: "telegram-alert-target-status",
      updateCount: updates.length,
    });
  }
}

export async function recordTelegramAlertTargetCancellations(
  db: D1Database,
  cancellations: readonly TelegramAlertTargetCancellation[],
): Promise<void> {
  if (cancellations.length === 0) return;
  try {
    await batchExecute(db, cancellations.map((cancellation) =>
      db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET status = 'failed',
                  failed_at = COALESCE(failed_at, ?),
                  error_class = COALESCE(error_class, 'preference_changed'),
                  cancelled_at = COALESCE(cancelled_at, ?),
                  cancellation_reason = COALESCE(cancellation_reason, ?)
            WHERE pending_dedupe_key = ?
              AND source_event_id = ?
              AND status <> 'sent'
              AND effect_state NOT IN ('sending', 'execution_unknown')
              ${cancellation.pendingGuard ? `AND (${cancellation.pendingGuard.sql})` : ""}`,
        )
        .bind(
          cancellation.at, cancellation.at, cancellation.reason, cancellation.targetKey, cancellation.sourceEventId,
          ...(cancellation.pendingGuard?.binds ?? []),
        ),
    ));
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to cancel Telegram alert job targets",
      action: "cancel-alert-job-targets",
      module: "telegram-alert-target-status",
      updateCount: cancellations.length,
    });
  }
}

export async function reconcileExpiredTelegramAlertJobTargets(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<number> {
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET status = 'expired',
                  failed_at = COALESCE(failed_at, ?),
                  error_class = COALESCE(error_class, 'ttl_expired')
            WHERE status IN ('planned', 'queued')
              AND created_at < ?`,
        )
        .bind(nowSec, nowSec - Math.max(...Object.values(TELEGRAM_ALERT_TTL_SEC)))
        .run(),
    3,
    signal,
  );
  await reconcileSettledTelegramFreezeJobCounters(db, nowSec, signal);
  return Number(result.meta?.changes ?? 0);
}

/**
 * Freeze jobs are reconciled only at handoff, so target status changes made
 * later (TTL expiry above, drain status telemetry) can leave the job `queued`
 * forever. Once the freeze cohort is fully handed off (or expired) and no target is still
 * planned/queued, recompute the job counters from its target rows.
 */
async function reconcileSettledTelegramFreezeJobCounters(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const rows = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT job.job_id
             FROM telegram_alert_jobs job
             JOIN telegram_freeze_alert_events event
               ON event.source_event_id = job.source_event_id AND event.status IN ('complete', 'expired')
            WHERE job.alert_type = 'freeze'
              AND job.status IN ('discovered', 'queued')
              AND EXISTS (SELECT 1 FROM telegram_alert_job_targets target WHERE target.job_id = job.job_id)
              AND NOT EXISTS (
                SELECT 1 FROM telegram_alert_job_targets target
                 WHERE target.job_id = job.job_id
                   AND target.final_delivery_state IS NULL
                   AND target.status IN ('planned', 'queued')
              )
            ORDER BY job.job_id
            LIMIT 90`,
        )
        .all<{ job_id: string }>(),
    3,
    signal,
  );
  await reconcileTelegramAlertJobCounters(db, (rows.results ?? []).map((row) => row.job_id), nowSec);
}
