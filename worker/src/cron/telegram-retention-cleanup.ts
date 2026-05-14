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
  cutoff: number | string,
): Promise<number> {
  const result = await db.prepare(sql).bind(cutoff).run();
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

  // `day` is TEXT (YYYY-MM-DD) in telegram_usage_daily and
  // telegram_watcher_lifecycle_daily; an integer cutoff would never match. Bind
  // the cutoff as a YYYY-MM-DD string so the comparison is text-vs-text.
  const cutoffDayString = new Date((nowSec - USAGE_DAILY_RETENTION_SEC) * 1000)
    .toISOString()
    .slice(0, 10);

  const usageDailyPruned = await deleteOlderThan(
    db,
    "DELETE FROM telegram_usage_daily WHERE day < ?",
    cutoffDayString,
  );
  throwIfAborted(signal);

  const watcherLifecyclePruned = await deleteOlderThan(
    db,
    "DELETE FROM telegram_watcher_lifecycle_daily WHERE day < ?",
    cutoffDayString,
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
    watcherLifecyclePruned +
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
      watcherLifecyclePruned,
      diagnosticsPruned,
      expiredTargetsReconciled,
      retentionDays: {
        alertAudit: ALERT_AUDIT_RETENTION_SEC / DAY_SEC,
        usageDaily: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        watcherLifecycle: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        chatDiagnostics: CHAT_DIAGNOSTICS_RETENTION_SEC / DAY_SEC,
        processedUpdates: 7,
      },
    },
  });
}
