import { batchExecute, buildInClause, chunkArray } from "../lib/db";
import { runWithOverloadRetry } from "../lib/cron-lease";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";

export interface TelegramAlertTargetStatusUpdate {
  targetKey: string;
  status: "queued" | "sent" | "failed" | "expired";
  at: number;
  errorClass?: string | null;
}

export interface TelegramAlertTargetCancellation {
  targetKey: string;
  at: number;
  reason: string;
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
        );
    }));
  } catch (error) {
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
              AND status <> 'sent'
              AND effect_state NOT IN ('sending', 'execution_unknown')`,
        )
        .bind(cancellation.at, cancellation.at, cancellation.reason, cancellation.targetKey),
    ));
  } catch (error) {
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
  return Number(result.meta?.changes ?? 0);
}

export async function loadTerminalTelegramAlertTargetKeys(
  db: D1Database,
  targetKeys: readonly string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(targetKeys));
  const terminal = new Set<string>();
  for (const keyChunk of chunkArray(unique)) {
    const inClause = buildInClause(keyChunk);
    const rows = await db
      .prepare(
        `SELECT pending_dedupe_key
           FROM telegram_alert_job_targets
          WHERE pending_dedupe_key IN (${inClause.sql})
            AND (
              status IN ('queued', 'sent', 'failed', 'expired')
              OR effect_state IN ('sending', 'complete', 'execution_unknown')
            )`,
      )
      .bind(...inClause.binds)
      .all<{ pending_dedupe_key: string }>();
    for (const row of rows.results ?? []) {
      terminal.add(row.pending_dedupe_key);
    }
  }
  return terminal;
}
