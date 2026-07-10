import { runWithOverloadRetry } from "../../lib/cron-lease";
import { TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC, TELEGRAM_PROCESSING_STALE_SEC } from "../../lib/telegram-constants";
import { d1ChangeCount } from "./_internals";
import { unixNow } from "./subscribers";

export const TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT = 5_000;
export const TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT = TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT + 1;

export interface TelegramProcessedUpdateBacklog {
  count: number;
  exact: boolean;
  probeLimit: number;
}

export type TelegramProcessedUpdateClaimStatus = "claimed" | "duplicate" | "in_flight" | "effect_unknown";

export interface TelegramProcessedUpdateClaim {
  status: TelegramProcessedUpdateClaimStatus;
  retryAfterSec?: number;
  claimOwner?: string;
  claimGeneration?: number;
}

interface ProcessedUpdateRow {
  status: string;
  received_at: number;
  effect_state: string;
  claim_owner: string | null;
  claim_generation: number;
}

function createProcessedUpdateClaimOwner(updateId: number): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const suffix = cryptoObj?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `telegram-update:${updateId}:${suffix}`;
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
  const claimOwner = createProcessedUpdateClaimOwner(input.updateId);
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO telegram_processed_updates (
         update_id,
         received_at,
         processed_at,
         update_type,
         chat_id,
         status,
         error_class,
         effect_state,
         effect_key,
         effect_started_at,
         claim_owner,
         claim_generation
       )
       VALUES (?, ?, NULL, ?, ?, 'processing', NULL, 'unstarted', ?, NULL, ?, 1)`,
    )
    .bind(
      input.updateId,
      input.nowSec,
      input.updateType,
      input.chatId,
      `telegram-update:${input.updateId}`,
      claimOwner,
    )
    .run();

  if (d1ChangeCount(insert) > 0) {
    return { status: "claimed", claimOwner, claimGeneration: 1 };
  }

  const existing = await db
    .prepare(
      `SELECT status, received_at, effect_state, claim_owner, claim_generation
         FROM telegram_processed_updates
        WHERE update_id = ?`,
    )
    .bind(input.updateId)
    .first<ProcessedUpdateRow>();

  if (!existing) {
    return { status: "in_flight", retryAfterSec: staleSec };
  }

  if (existing.status === "processed") {
    return { status: "duplicate" };
  }

  if (existing.effect_state === "started") {
    return { status: "effect_unknown" };
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
              error_class = NULL,
              effect_state = 'unstarted',
              effect_started_at = NULL,
              claim_owner = ?,
              claim_generation = claim_generation + 1
        WHERE update_id = ?
          AND effect_state = 'unstarted'
          AND claim_generation = ?
          AND (
            status = 'failed'
            OR (status = 'processing' AND received_at <= ?)
          )`,
    )
    .bind(
      input.nowSec,
      input.updateType,
      input.chatId,
      claimOwner,
      input.updateId,
      existing.claim_generation,
      staleBefore,
    )
    .run();

  if (d1ChangeCount(reclaim) > 0) {
    return {
      status: "claimed",
      claimOwner,
      claimGeneration: existing.claim_generation + 1,
    };
  }

  return { status: "in_flight", retryAfterSec: staleSec };
}

export async function markTelegramProcessedUpdateEffectStarted(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
  },
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET effect_state = 'started',
              effect_started_at = ?
        WHERE update_id = ?
          AND status = 'processing'
          AND effect_state = 'unstarted'
          AND claim_owner = ?
          AND claim_generation = ?`,
    )
    .bind(input.nowSec, input.updateId, input.claimOwner, input.claimGeneration)
    .run();
  if (d1ChangeCount(result) !== 1) {
    throw new Error("Telegram update lost its effect-start claim");
  }
}

export async function markTelegramProcessedUpdateProcessed(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    claimOwner: string;
    claimGeneration: number;
    errorClass?: string | null;
  },
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'processed',
              processed_at = ?,
              error_class = ?
        WHERE update_id = ?
          AND status = 'processing'
          AND effect_state = 'started'
          AND claim_owner = ?
          AND claim_generation = ?`,
    )
    .bind(
      input.nowSec,
      input.errorClass ?? null,
      input.updateId,
      input.claimOwner,
      input.claimGeneration,
    )
    .run();
  if (d1ChangeCount(result) !== 1) {
    throw new Error("Telegram update terminal marker lost ownership");
  }
}

export async function markTelegramProcessedUpdateFailed(
  db: D1Database,
  input: {
    updateId: number;
    claimOwner: string;
    claimGeneration: number;
    errorClass: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'failed',
              processed_at = NULL,
              error_class = ?
        WHERE update_id = ?
          AND status = 'processing'
          AND effect_state = 'started'
          AND claim_owner = ?
          AND claim_generation = ?`,
    )
    .bind(
      input.errorClass,
      input.updateId,
      input.claimOwner,
      input.claimGeneration,
    )
    .run();
}

export async function pruneTelegramProcessedUpdates(
  db: D1Database,
  input: { nowSec?: number; retentionSec?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const nowSec = input.nowSec ?? unixNow();
  const retentionSec = input.retentionSec ?? TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC;
  const limit = input.limit ?? TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT) {
    throw new RangeError(
      `Telegram processed-update prune limit must be between 1 and ${TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT}.`,
    );
  }
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `DELETE FROM telegram_processed_updates
            WHERE update_id IN (
              SELECT update_id
                FROM telegram_processed_updates
               WHERE received_at < ?
               ORDER BY received_at ASC, update_id ASC
               LIMIT ?
            )`,
        )
        .bind(nowSec - retentionSec, limit)
        .run(),
    3,
    input.signal,
  );
  return d1ChangeCount(result);
}

export async function countTelegramProcessedUpdateBacklog(
  db: D1Database,
  input: { nowSec?: number; retentionSec?: number; signal?: AbortSignal } = {},
): Promise<TelegramProcessedUpdateBacklog> {
  const nowSec = input.nowSec ?? unixNow();
  const retentionSec = input.retentionSec ?? TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC;
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM (
               SELECT update_id
                 FROM telegram_processed_updates
                WHERE received_at < ?
                ORDER BY received_at ASC, update_id ASC
                LIMIT ?
             )`,
        )
        .bind(nowSec - retentionSec, TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT)
        .first<{ count: number }>(),
    3,
    input.signal,
  );
  const count = Math.max(0, Number(row?.count ?? 0));
  return {
    count,
    exact: count < TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT,
    probeLimit: TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT,
  };
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

  const row = await db.prepare("SELECT updated_at FROM cache WHERE key = ?").bind(key).first<{ updated_at: number }>();
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

/** @internal Exported so the SQLite contention regression executes the production statement. */
export const TELEGRAM_CHAT_FLOOD_UPSERT_SQL = `INSERT INTO cache (key, value, updated_at)
 VALUES (?, '1', ?)
 ON CONFLICT(key) DO UPDATE SET
   value = CASE
     WHEN cache.updated_at <= ? THEN '1'
     ELSE CAST(COALESCE(CAST(cache.value AS INTEGER), 0) + 1 AS TEXT)
   END,
   updated_at = CASE
     WHEN cache.updated_at <= ? THEN excluded.updated_at
     ELSE cache.updated_at
   END
 RETURNING value`;

/**
 * Generous per-chat fixed-window command counter covering every command,
 * including light ones with no per-command cooldown. The conditional upsert
 * increments or rotates the window atomically under concurrent webhooks.
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
  const rotateBeforeOrAt = input.nowSec - input.windowSec;
  const row = await db
    .prepare(TELEGRAM_CHAT_FLOOD_UPSERT_SQL)
    .bind(key, input.nowSec, rotateBeforeOrAt, rotateBeforeOrAt)
    .first<{ value: string }>();
  const count = Number.parseInt(row?.value ?? "", 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error("Telegram chat flood counter upsert returned no valid count");
  }
  return { allowed: count <= input.limit, firstExceeded: count === input.limit + 1 };
}
