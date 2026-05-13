import { throwIfAborted } from "../lib/abort";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { pruneTelegramProcessedUpdates } from "../api/telegram-webhook-store";
import { reconcileExpiredTelegramAlertJobTargets } from "./telegram-alert-target-status";

const DAY_SEC = 24 * 60 * 60;
const ALERT_AUDIT_RETENTION_SEC = 90 * DAY_SEC;
const USAGE_DAILY_RETENTION_SEC = 400 * DAY_SEC;
const CHAT_DIAGNOSTICS_RETENTION_SEC = 90 * DAY_SEC;

async function deleteOlderThan(
  db: D1Database,
  sql: string,
  cutoffSec: number,
): Promise<number> {
  const result = await db.prepare(sql).bind(cutoffSec).run();
  return Number(result.meta?.changes ?? 0);
}

export async function runTelegramRetentionCleanup(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredTargetsReconciled = await reconcileExpiredTelegramAlertJobTargets(db, nowSec);
  throwIfAborted(signal);

  const processedUpdatesPruned = await pruneTelegramProcessedUpdates(db, { nowSec });
  throwIfAborted(signal);

  const deadLettersPruned = await deleteOlderThan(
    db,
    "DELETE FROM telegram_alert_dead_letters WHERE expired_at < ?",
    nowSec - ALERT_AUDIT_RETENTION_SEC,
  );
  throwIfAborted(signal);

  const jobTargetsPruned = await deleteOlderThan(
    db,
    "DELETE FROM telegram_alert_job_targets WHERE created_at < ?",
    nowSec - ALERT_AUDIT_RETENTION_SEC,
  );
  throwIfAborted(signal);

  const jobsPruned = await deleteOlderThan(
    db,
    "DELETE FROM telegram_alert_jobs WHERE created_at < ?",
    nowSec - ALERT_AUDIT_RETENTION_SEC,
  );
  throwIfAborted(signal);

  const usageDailyPruned = await deleteOlderThan(
    db,
    "DELETE FROM telegram_usage_daily WHERE day < ?",
    nowSec - USAGE_DAILY_RETENTION_SEC,
  );
  throwIfAborted(signal);

  const diagnosticsPruned = await deleteOlderThan(
    db,
    "DELETE FROM telegram_chat_delivery_diagnostics WHERE updated_at < ?",
    nowSec - CHAT_DIAGNOSTICS_RETENTION_SEC,
  );

  const totalPruned =
    processedUpdatesPruned +
    deadLettersPruned +
    jobTargetsPruned +
    jobsPruned +
    usageDailyPruned +
    diagnosticsPruned;

  return createCronResult({
    status: "ok",
    itemCount: totalPruned,
    metadata: {
      processedUpdatesPruned,
      deadLettersPruned,
      jobTargetsPruned,
      jobsPruned,
      usageDailyPruned,
      diagnosticsPruned,
      expiredTargetsReconciled,
      retentionDays: {
        alertAudit: ALERT_AUDIT_RETENTION_SEC / DAY_SEC,
        usageDaily: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        chatDiagnostics: CHAT_DIAGNOSTICS_RETENTION_SEC / DAY_SEC,
        processedUpdates: 7,
      },
    },
  });
}
