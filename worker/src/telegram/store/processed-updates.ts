import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import {
  TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC,
  TELEGRAM_PROCESSING_STALE_SEC,
} from "../common/constants";
import { d1ChangeCount } from "../delivery/operation-batch";
import { unixNowSec as unixNow } from "@shared/lib/time-constants";

export const TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT = 5_000;
const TELEGRAM_PROCESSED_UPDATE_BACKLOG_PROBE_LIMIT = TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT + 1;

export const TELEGRAM_WEBHOOK_INTENT_VERSION = 1 as const;

/**
 * Shape still accepted by the optional handler hooks (`planIntent`,
 * `storedIntent`). The webhook no longer records or replays intents, so these
 * hooks are never supplied and handlers run their direct path.
 */
export interface TelegramWebhookOperationIntent {
  version: typeof TELEGRAM_WEBHOOK_INTENT_VERSION;
  kind: string;
  mutation: "none" | "required";
  payload: Record<string, unknown>;
}

export interface TelegramProcessedUpdateBacklog {
  count: number;
  exact: boolean;
  probeLimit: number;
}

/**
 * `claimed`: this request owns the update. `duplicate`: already processed, ack
 * and skip. `in_flight`: another request holds a fresh claim; answer non-2xx so
 * Telegram redelivers after that claim either finishes or goes stale.
 */
export type TelegramProcessedUpdateClaim =
  | { status: "claimed" | "duplicate" }
  | { status: "in_flight"; retryAfterSec: number };

/**
 * Claims an update id. Unfinished claims (a crashed request, or legacy
 * `failed`/effect-fence rows) become reclaimable after the stale window, so a
 * stuck `processing` row never blocks Telegram's retry for longer than that.
 */
export async function claimTelegramProcessedUpdate(
  db: D1Database,
  input: {
    updateId: number;
    nowSec: number;
    updateType: string | null;
    chatId: string | null;
  },
): Promise<TelegramProcessedUpdateClaim> {
  const staleBefore = input.nowSec - TELEGRAM_PROCESSING_STALE_SEC;
  const claim = await db
    .prepare(
      `INSERT INTO telegram_processed_updates (update_id, received_at, update_type, chat_id, status)
       VALUES (?, ?, ?, ?, 'processing')
       ON CONFLICT(update_id) DO UPDATE SET
         received_at = excluded.received_at,
         processed_at = NULL,
         update_type = excluded.update_type,
         chat_id = excluded.chat_id,
         status = 'processing',
         error_class = NULL
       WHERE telegram_processed_updates.status = 'failed'
          OR (telegram_processed_updates.status = 'processing' AND telegram_processed_updates.received_at <= ?)`,
    )
    .bind(input.updateId, input.nowSec, input.updateType, input.chatId, staleBefore)
    .run();
  if (d1ChangeCount(claim) > 0) return { status: "claimed" };

  const existing = await db
    .prepare("SELECT status, received_at FROM telegram_processed_updates WHERE update_id = ?")
    .bind(input.updateId)
    .first<{ status: string; received_at: number }>();
  if (existing?.status === "processed") return { status: "duplicate" };
  const receivedAt = Number(existing?.received_at ?? input.nowSec);
  return {
    status: "in_flight",
    retryAfterSec: Math.max(1, receivedAt + TELEGRAM_PROCESSING_STALE_SEC - input.nowSec),
  };
}

/**
 * `claimedAt` is the `received_at` this request claimed with. A request that
 * outlived the stale window and lost its claim to a redelivery leaves the
 * reclaimer's row alone.
 */
export interface TelegramProcessedUpdateClaimRef {
  updateId: number;
  claimedAt: number;
}

export async function markTelegramProcessedUpdateProcessed(
  db: D1Database,
  input: TelegramProcessedUpdateClaimRef & { nowSec: number; errorClass?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_processed_updates
          SET status = 'processed', processed_at = ?, error_class = ?
        WHERE update_id = ? AND status = 'processing' AND received_at = ?`,
    )
    .bind(input.nowSec, input.errorClass ?? null, input.updateId, input.claimedAt)
    .run();
}

/** Drops this request's unfinished claim so Telegram's redelivery of the update is processed. */
export async function releaseTelegramProcessedUpdate(
  db: D1Database,
  claim: TelegramProcessedUpdateClaimRef,
): Promise<void> {
  await db
    .prepare("DELETE FROM telegram_processed_updates WHERE update_id = ? AND status = 'processing' AND received_at = ?")
    .bind(claim.updateId, claim.claimedAt)
    .run();
}

export async function pruneTelegramProcessedUpdates(
  db: D1Database,
  input: {
    nowSec?: number;
    retentionSec?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
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
  input: {
    nowSec?: number;
    retentionSec?: number;
    signal?: AbortSignal;
  } = {},
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
