import { batchExecute, buildInClause, chunkArray } from "../lib/db";
import { TELEGRAM_ALERT_TTL_SEC } from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";

export interface TelegramAlertTargetStatusUpdate {
  targetKey: string;
  status: "queued" | "sent" | "failed" | "expired";
  at: number;
  errorClass?: string | null;
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
              AND status <> 'sent'`,
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
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to update Telegram alert job targets: ${message}`,
      action: "update-alert-job-targets",
      module: "telegram-alert-target-status",
      updateCount: updates.length,
    });
  }
}

export async function reconcileExpiredTelegramAlertJobTargets(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE telegram_alert_job_targets
          SET status = 'expired',
              failed_at = COALESCE(failed_at, ?),
              error_class = COALESCE(error_class, 'ttl_expired')
        WHERE status IN ('planned', 'queued')
          AND created_at < ?`,
    )
    .bind(nowSec, nowSec - Math.max(...Object.values(TELEGRAM_ALERT_TTL_SEC)))
    .run();
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
            AND status IN ('sent', 'expired')`,
      )
      .bind(...inClause.binds)
      .all<{ pending_dedupe_key: string }>();
    for (const row of rows.results ?? []) {
      terminal.add(row.pending_dedupe_key);
    }
  }
  return terminal;
}
