import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { runBoundedQueue } from "./shared/bounded-queue";

/**
 * Weekly cleanup of inactive Telegram subscribers.
 *
 * Deletes rows from `telegram_subscribers` where:
 *   - `last_active_at < (now - INACTIVE_RETENTION_SEC)` (180 days), AND
 *   - the chat has zero rows in any of:
 *       `telegram_subscriptions`
 *       `telegram_preset_subscriptions`
 *       `telegram_pending_alerts`
 *       `telegram_pending_disambiguation`
 *
 * Cap at `MAX_DELETIONS_PER_RUN` per invocation so a large backlog cannot
 * push the daily-0300 slot past D1's per-statement budget. The cleanup is
 * additionally gated by a 7-day `cache` guard so the daily lane only does
 * real work once a week.
 */
const INACTIVE_RETENTION_SEC = 180 * 24 * 60 * 60;
const RUN_INTERVAL_SEC = 7 * 24 * 60 * 60;
const MAX_DELETIONS_PER_RUN = 100;
const CACHE_LAST_RUN_KEY = "cron:telegram-inactive-cleanup:last-run";

interface CandidateRow {
  chat_id: string;
}

async function loadLastRunSec(db: D1Database): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .bind(CACHE_LAST_RUN_KEY)
      .first<{ value: string }>();
    if (!row) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function recordLastRunSec(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(CACHE_LAST_RUN_KEY, String(now), now)
    .run();
}

async function loadCandidateChats(db: D1Database, cutoffSec: number, limit: number): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT s.chat_id AS chat_id
         FROM telegram_subscribers s
         LEFT JOIN telegram_subscriptions sub ON sub.chat_id = s.chat_id
         LEFT JOIN telegram_preset_subscriptions ps ON ps.chat_id = s.chat_id
         LEFT JOIN telegram_pending_alerts pa ON pa.chat_id = s.chat_id
         LEFT JOIN telegram_pending_disambiguation pd ON pd.chat_id = s.chat_id
        WHERE s.last_active_at < ?
          AND sub.chat_id IS NULL
          AND ps.chat_id IS NULL
          AND pa.chat_id IS NULL
          AND pd.chat_id IS NULL
        ORDER BY s.last_active_at ASC
        LIMIT ?`,
    )
    .bind(cutoffSec, limit)
    .all<CandidateRow>();
  return (result.results ?? []).map((row) => row.chat_id);
}

async function deleteChatCascade(db: D1Database, chatId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_alerts WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?").bind(chatId),
  ]);
}

export async function runTelegramInactiveCleanup(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);

  const lastRunSec = await loadLastRunSec(db);
  if (lastRunSec != null && now - lastRunSec < RUN_INTERVAL_SEC) {
    return {
      status: "ok",
      itemCount: 0,
      metadata: JSON.stringify({
        skipped: "cache-guard",
        lastRunSec,
        nextEligibleSec: lastRunSec + RUN_INTERVAL_SEC,
      }),
    };
  }
  throwIfAborted(signal);

  const cutoffSec = now - INACTIVE_RETENTION_SEC;
  const candidates = await loadCandidateChats(db, cutoffSec, MAX_DELETIONS_PER_RUN);
  throwIfAborted(signal);

  const deletionResults = await runBoundedQueue({
    items: candidates,
    concurrency: 1,
    signal,
    worker: async (chatId) => {
      await deleteChatCascade(db, chatId);
      return 1;
    },
  });
  const deleted = deletionResults.reduce((sum, count) => sum + count, 0);

  await recordLastRunSec(db, now);

  return {
    status: "ok",
    itemCount: deleted,
    metadata: JSON.stringify({
      cutoffSec,
      deleted,
      cappedAtLimit: deleted >= MAX_DELETIONS_PER_RUN,
    }),
  };
}
