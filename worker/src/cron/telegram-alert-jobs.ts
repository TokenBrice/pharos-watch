import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import type { PerAlertTypeDelivery, TelegramAlertType } from "@shared/types/status";
import {
  batchExecute,
  executeAtomicBatch,
  prepareMultiRowInsertStatements,
} from "../lib/db";
import { D1_BATCH_SIZE } from "../lib/constants";
import { toErrorMessage } from "../lib/error-utils";
import {
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";
import {
  buildDedupeKey,
  estimateTelegramDrainTimeSec,
  hashDedupePart,
} from "./telegram-pending";
import {
  expandSubscriberChunks,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";
import { listTelegramAlertItemKeys } from "./telegram-alert-event-lineage";

export interface TelegramAlertJobManifest {
  jobId: string;
  alertType: TelegramAlertType;
  targetCount: number;
  targetKeys: readonly string[];
}

export function buildFreshTargetJobIdMap(
  manifests: readonly TelegramAlertJobManifest[],
): Map<string, string> {
  const jobIdByTargetKey = new Map<string, string>();
  for (const manifest of manifests) {
    for (const targetKey of manifest.targetKeys) {
      const existing = jobIdByTargetKey.get(targetKey);
      if (existing && existing !== manifest.jobId) {
        throw new Error(`Telegram fresh target belongs to multiple jobs (${hashDedupePart(targetKey)})`);
      }
      jobIdByTargetKey.set(targetKey, manifest.jobId);
    }
  }
  return jobIdByTargetKey;
}

function severityForAlertType(alertType: TelegramAlertType): "risk" | "info" {
  return alertType === "launch" ? "info" : "risk";
}

function ttlForAlertType(alertType: TelegramAlertType): number {
  return TELEGRAM_ALERT_TTL_SEC[alertType];
}

export async function persistTelegramAlertJobManifests(
  db: D1Database,
  subscriberQueue: RoutedSubscriberAlert[],
  nowSec: number,
  options: {
    sourceEventId?: string;
    sourceDetectedAt?: number;
  } = {},
): Promise<TelegramAlertJobManifest[]> {
  const manifests: TelegramAlertJobManifest[] = [];

  for (const alertType of TELEGRAM_ALERT_TYPES) {
    const subscribers = subscriberQueue.filter((entry) => entry.alertType === alertType);
    if (subscribers.length === 0) continue;

    const messageEntries = subscribers.flatMap((subscriber) =>
      expandSubscriberChunks([subscriber]).map((message) => ({
        message,
        itemKeys: listTelegramAlertItemKeys(subscriber.alerts),
      })),
    );
    const messages = messageEntries.map((entry) => entry.message);
    if (messages.length === 0) continue;

    const targetKeys = messages.map((message) => buildDedupeKey(message)).sort();
    const sourceEventId = options.sourceEventId ?? `${alertType}:v1:${hashDedupePart(targetKeys.join("|"))}`;
    const jobId = options.sourceEventId
      ? `telegram:${sourceEventId}:${alertType}`
      : `telegram:${sourceEventId}`;
    const createdAt = options.sourceDetectedAt ?? nowSec;
    const expiresAt = createdAt + ttlForAlertType(alertType);
    const lastCursor = targetKeys[targetKeys.length - 1] ?? null;
    const metadata = JSON.stringify({
      rolloutStage: "dual-write-manifest",
      targetChats: subscribers.length,
      targetChunks: messages.length,
      drainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
      estimatedDrainTimeSec: estimateTelegramDrainTimeSec(messages.length),
    });

    try {
      await db
        .prepare(
          `INSERT INTO telegram_alert_jobs (
             job_id, alert_type, source_event_id, severity, created_at, expires_at,
             status, target_count, sent_count, enqueued_count, failed_count, last_cursor, metadata
           )
           VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, 0, 0, 0, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             target_count = excluded.target_count,
             expires_at = MAX(telegram_alert_jobs.expires_at, excluded.expires_at),
             last_cursor = excluded.last_cursor,
             metadata = excluded.metadata`,
        )
        .bind(
          jobId,
          alertType,
          sourceEventId,
          severityForAlertType(alertType),
          createdAt,
          expiresAt,
          messages.length,
          lastCursor,
          metadata,
        )
        .run();

      const targetUnits = messageEntries.map(({ message, itemKeys }) => {
        const targetKey = buildDedupeKey(message);
        const statements = [
          db
            .prepare(
              `INSERT INTO telegram_alert_job_targets (
                 job_id, target_key, chat_id, chunk_index, alert_type, status,
                 pending_dedupe_key, created_at
               )
               VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)
               ON CONFLICT(job_id, target_key) DO NOTHING`,
            )
            .bind(
              jobId,
              targetKey,
              message.chatId,
              message.chunkIndex ?? 0,
              alertType,
              targetKey,
              createdAt,
            ),
        ];
        if (options.sourceEventId && itemKeys.length > 0) {
          statements.push(
            ...prepareMultiRowInsertStatements(
              db,
              `INSERT OR IGNORE INTO telegram_alert_job_target_items (
                 job_id, target_key, source_event_id, item_key, created_at
               )`,
              itemKeys.map((itemKey) => [jobId, targetKey, sourceEventId, itemKey, createdAt]),
            ),
          );
        }
        return statements;
      });
      let statementBatch: D1PreparedStatement[] = [];
      for (const unit of targetUnits) {
        if (unit.length > D1_BATCH_SIZE) {
          throw new Error(`Telegram target lineage exceeds the D1 batch limit (${unit.length})`);
        }
        if (statementBatch.length + unit.length > D1_BATCH_SIZE) {
          await executeAtomicBatch(db, statementBatch);
          statementBatch = [];
        }
        statementBatch.push(...unit);
      }
      await executeAtomicBatch(db, statementBatch);

      const targetCountRow = await db
        .prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets WHERE job_id = ?")
        .bind(jobId)
        .first<{ count: number }>();
      const targetCount = Number(targetCountRow?.count ?? messages.length);
      await db
        .prepare(
          `UPDATE telegram_alert_jobs
              SET target_count = ?,
                  last_cursor = ?
            WHERE job_id = ?`,
        )
        .bind(targetCount, lastCursor, jobId)
        .run();

      manifests.push({ jobId, alertType, targetCount, targetKeys });
    } catch (error) {
      const message = toErrorMessage(error);
      logTelegramEvent({
        level: "warn",
        message: `Failed to persist Telegram alert job manifest: ${message}`,
        action: "persist-alert-job-manifest",
        module: "telegram-alert-jobs",
      });
      throw error;
    }
  }

  return manifests;
}

export async function finalizeTelegramAlertJobManifests(
  db: D1Database,
  manifests: TelegramAlertJobManifest[],
  perAlertType: PerAlertTypeDelivery,
  nowSec: number,
): Promise<void> {
  if (manifests.length === 0) return;

  try {
    await batchExecute(db, manifests.map((manifest) => {
      const stats = perAlertType[manifest.alertType];
      const failedCount = stats.failed + stats.blocked;
      const metadata = JSON.stringify({
        finalizedAt: nowSec,
        latestAttempt: {
          sent: stats.sent,
          enqueued: stats.enqueued,
          failed: failedCount,
        },
        countersSource: "target-rows",
      });
      return db
        .prepare(
          `UPDATE telegram_alert_jobs
              SET status = CASE
                    WHEN EXISTS (
                      SELECT 1 FROM telegram_alert_job_targets target
                       WHERE target.job_id = telegram_alert_jobs.job_id
                         AND target.status IN ('failed', 'expired')
                    ) THEN 'degraded'
                    WHEN EXISTS (
                      SELECT 1 FROM telegram_alert_job_targets target
                       WHERE target.job_id = telegram_alert_jobs.job_id
                         AND target.status = 'planned'
                    ) THEN 'discovered'
                    WHEN EXISTS (
                      SELECT 1 FROM telegram_alert_job_targets target
                       WHERE target.job_id = telegram_alert_jobs.job_id
                         AND target.status = 'queued'
                    ) THEN 'queued'
                    ELSE 'sent'
                  END,
                  target_count = (
                    SELECT COUNT(*) FROM telegram_alert_job_targets target
                     WHERE target.job_id = telegram_alert_jobs.job_id
                  ),
                  sent_count = (
                    SELECT COUNT(*) FROM telegram_alert_job_targets target
                     WHERE target.job_id = telegram_alert_jobs.job_id AND target.status = 'sent'
                  ),
                  enqueued_count = (
                    SELECT COUNT(*) FROM telegram_alert_job_targets target
                     WHERE target.job_id = telegram_alert_jobs.job_id AND target.status = 'queued'
                  ),
                  failed_count = (
                    SELECT COUNT(*) FROM telegram_alert_job_targets target
                     WHERE target.job_id = telegram_alert_jobs.job_id
                       AND target.status IN ('failed', 'expired')
                  ),
                  metadata = ?
            WHERE job_id = ?`,
        )
        .bind(
          metadata,
          manifest.jobId,
        );
    }));
  } catch (error) {
    const message = toErrorMessage(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to finalize Telegram alert job manifests: ${message}`,
      action: "finalize-alert-job-manifest",
      module: "telegram-alert-jobs",
    });
  }
}
