import type { PerAlertTypeDelivery, TelegramAlertType } from "@shared/types/status";
import { batchExecute } from "../lib/db";
import {
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "../lib/telegram-constants";
import { logTelegramEvent } from "../lib/telegram-log";
import {
  buildDedupeKey,
  estimateTelegramDrainTimeSec,
  hashDedupePart,
} from "./telegram-pending-queue";
import {
  expandSubscriberChunks,
  type RoutedSubscriberAlert,
} from "./dispatch-telegram-routing";

export interface TelegramAlertJobManifest {
  jobId: string;
  alertType: TelegramAlertType;
  targetCount: number;
}

const ALERT_TYPES: readonly TelegramAlertType[] = ["depeg", "dews", "safety", "launch"];

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
): Promise<TelegramAlertJobManifest[]> {
  const manifests: TelegramAlertJobManifest[] = [];

  for (const alertType of ALERT_TYPES) {
    const subscribers = subscriberQueue.filter((entry) => entry.alertType === alertType);
    if (subscribers.length === 0) continue;

    const messages = expandSubscriberChunks(subscribers);
    if (messages.length === 0) continue;

    const targetKeys = messages.map((message) => buildDedupeKey(message)).sort();
    const sourceEventId = `${alertType}:v1:${hashDedupePart(targetKeys.join("|"))}`;
    const jobId = `telegram:${sourceEventId}`;
    const expiresAt = nowSec + ttlForAlertType(alertType);
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
          nowSec,
          expiresAt,
          messages.length,
          lastCursor,
          metadata,
        )
        .run();

      await batchExecute(db, messages.map((message) => {
        const targetKey = buildDedupeKey(message);
        return db
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
            nowSec,
          );
      }));

      manifests.push({ jobId, alertType, targetCount: messages.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      const status = failedCount > 0
        ? "degraded"
        : stats.enqueued > 0
          ? "queued"
          : "sent";
      const metadata = JSON.stringify({
        finalizedAt: nowSec,
        sent: stats.sent,
        enqueued: stats.enqueued,
        failed: failedCount,
        targetCount: manifest.targetCount,
      });
      return db
        .prepare(
          `UPDATE telegram_alert_jobs
              SET status = ?,
                  sent_count = ?,
                  enqueued_count = ?,
                  failed_count = ?,
                  metadata = ?
            WHERE job_id = ?`,
        )
        .bind(
          status,
          stats.sent,
          stats.enqueued,
          failedCount,
          metadata,
          manifest.jobId,
        );
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTelegramEvent({
      level: "warn",
      message: `Failed to finalize Telegram alert job manifests: ${message}`,
      action: "finalize-alert-job-manifest",
      module: "telegram-alert-jobs",
    });
  }
}
