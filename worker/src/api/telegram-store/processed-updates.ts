import {
  TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC,
  TELEGRAM_PROCESSING_STALE_SEC,
} from "../../lib/telegram-constants";
import { d1ChangeCount } from "./_internals";
import { unixNow } from "./subscribers";

const TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT = 5_000;

export type TelegramProcessedUpdateClaimStatus = "claimed" | "duplicate" | "in_flight";

export interface TelegramProcessedUpdateClaim {
  status: TelegramProcessedUpdateClaimStatus;
  retryAfterSec?: number;
}

interface ProcessedUpdateRow {
  status: string;
  received_at: number;
}

export async function claimTelegramProcessedUpdate(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    updateType: string | null;
    chatId: string | null;
    processingStaleSec?: number;
  },
): Promise<TelegramProcessedUpdateClaim> {
  const staleSec = input.processingStaleSec ?? TELEGRAM_PROCESSING_STALE_SEC;
  const staleBefore = input.nowSec - staleSec;
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO telegram_processed_updates (
         update_id,
         received_at,
         processed_at,
         update_type,
         chat_id,
         status,
         error_class
       )
       VALUES (?, ?, NULL, ?, ?, 'processing', NULL)`,
    )
    .bind(input.updateId, input.nowSec, input.updateType, input.chatId)
    .run();

  if (d1ChangeCount(insert) > 0) {
    return { status: "claimed" };
  }

  const existing = await db
    .prepare(
      "SELECT status, received_at FROM telegram_processed_updates WHERE update_id = ?",
    )
    .bind(input.updateId)
    .first<ProcessedUpdateRow>();

  if (!existing) {
    return { status: "in_flight", retryAfterSec: staleSec };
  }

  if (existing.status === "processed") {
    return { status: "duplicate" };
  }

  if (existing.status === "processing" && existing.received_at > staleBefore) {
    return {
      status: "in_flight",
      retryAfterSec: Math.max(1, existing.received_at + staleSec - input.nowSec),
    };
  }

  const reclaim = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET received_at = ?,
              processed_at = NULL,
              update_type = COALESCE(?, update_type),
              chat_id = COALESCE(?, chat_id),
              status = 'processing',
              error_class = NULL
        WHERE update_id = ?
          AND (
            status = 'failed'
            OR (status = 'processing' AND received_at <= ?)
          )`,
    )
    .bind(input.nowSec, input.updateType, input.chatId, input.updateId, staleBefore)
    .run();

  if (d1ChangeCount(reclaim) > 0) {
    return { status: "claimed" };
  }

  return { status: "in_flight", retryAfterSec: staleSec };
}

export async function markTelegramProcessedUpdateProcessed(
  db: D1Database,
  input: { updateId: number; nowSec: number; errorClass?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'processed',
              processed_at = ?,
              error_class = ?
        WHERE update_id = ?
          AND status = 'processing'`,
    )
    .bind(input.nowSec, input.errorClass ?? null, input.updateId)
    .run();
}

export async function markTelegramProcessedUpdateFailed(
  db: D1Database,
  input: { updateId: number; errorClass: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'failed',
              processed_at = NULL,
              error_class = ?
        WHERE update_id = ?
          AND status = 'processing'`,
    )
    .bind(input.errorClass, input.updateId)
    .run();
}

export async function pruneTelegramProcessedUpdates(
  db: D1Database,
  input: { nowSec?: number; retentionSec?: number } = {},
): Promise<number> {
  const nowSec = input.nowSec ?? unixNow();
  const retentionSec = input.retentionSec ?? TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC;
  const result = await db
    .prepare(
      `DELETE FROM telegram_processed_updates
        WHERE update_id IN (
          SELECT update_id
            FROM telegram_processed_updates
           WHERE received_at < ?
           ORDER BY received_at ASC, update_id ASC
           LIMIT ${TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT}
        )`,
    )
    .bind(nowSec - retentionSec)
    .run();
  return d1ChangeCount(result);
}

export interface TelegramCommandCooldownResult {
  allowed: boolean;
  retryAfterSec: number;
}

export async function acquireTelegramCommandCooldown(
  db: D1Database,
  input: {
    chatId: string;
    commandKey: string;
    nowSec: number;
    cooldownSec: number;
  },
): Promise<TelegramCommandCooldownResult> {
  const key = `telegram:command-cooldown:${input.chatId}:${input.commandKey}`;
  const eligibleBefore = input.nowSec - input.cooldownSec;
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE cache.updated_at <= ?`,
    )
    .bind(key, "1", input.nowSec, eligibleBefore)
    .run();

  if (d1ChangeCount(result) > 0) {
    return { allowed: true, retryAfterSec: 0 };
  }

  const row = await db
    .prepare("SELECT updated_at FROM cache WHERE key = ?")
    .bind(key)
    .first<{ updated_at: number }>();
  const lastUsedAt = Number(row?.updated_at);
  const retryAfterSec = Number.isFinite(lastUsedAt)
    ? Math.max(1, input.cooldownSec - (input.nowSec - lastUsedAt))
    : input.cooldownSec;
  return { allowed: false, retryAfterSec };
}

export async function releaseTelegramCommandCooldown(
  db: D1Database,
  input: {
    chatId: string;
    commandKey: string;
  },
): Promise<void> {
  const key = `telegram:command-cooldown:${input.chatId}:${input.commandKey}`;
  await db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run();
}

export interface TelegramChatCommandFloodResult {
  allowed: boolean;
  /** True exactly when this command crossed the limit, so callers reply once. */
  firstExceeded: boolean;
}

/**
 * Generous per-chat fixed-window command counter covering every command,
 * including light ones with no per-command cooldown. Concurrent webhook
 * deliveries may lose an increment; the cap is advisory, not a quota.
 */
export async function recordTelegramChatCommandFlood(
  db: D1Database,
  input: {
    chatId: string;
    nowSec: number;
    windowSec: number;
    limit: number;
  },
): Promise<TelegramChatCommandFloodResult> {
  const key = `telegram:command-flood:${input.chatId}`;
  const row = await db
    .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(key)
    .first<{ value: string; updated_at: number }>();
  const windowStartedAt = Number(row?.updated_at);
  const inWindow = Number.isFinite(windowStartedAt) && input.nowSec - windowStartedAt < input.windowSec;
  const count = inWindow ? (Number.parseInt(row?.value ?? "0", 10) || 0) + 1 : 1;
  await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(key, String(count), inWindow ? windowStartedAt : input.nowSec)
    .run();
  return { allowed: count <= input.limit, firstExceeded: count === input.limit + 1 };
}
