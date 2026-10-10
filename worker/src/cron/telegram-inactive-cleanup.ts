import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db-cache";
import {
  INACTIVE_TELEGRAM_SUBSCRIBER_ELIGIBILITY_SQL,
  purgeInactiveTelegramSubscriber,
} from "../lib/telegram/subscriber-lifecycle";
import { mapWithConcurrency } from "../lib/concurrency";

/**
 * Weekly cleanup of inactive Telegram subscribers.
 *
 * Deletes rows from `telegram_subscribers` where:
 *   - `last_active_at < (now - INACTIVE_RETENTION_SEC)` (180 days), AND
 *   - the chat has no meaningful rows in `telegram_subscriptions` (enabled
 *     alerts, explicit override markers, snooze, or tuning), AND
 *   - the chat has zero rows in any of:
 *       `telegram_preset_subscriptions`
 *       `telegram_pending_alerts`
 *       `telegram_pending_disambiguation`
 *   - no `global_alert_*` flags are enabled on `telegram_subscribers`
 *
 * Cap at `MAX_DELETIONS_PER_RUN` per invocation so a large backlog cannot
 * push the daily-0300 slot past D1's per-statement budget. The cleanup is
 * additionally gated by a 7-day `cache` guard so the daily lane only does
 * real work once a week.
 *
 * Live follows are never expired for inactivity. Empty profiles are deleted
 * without a warning because they have no deliverable alert state to recover;
 * users can create a fresh profile by interacting with the bot again.
 */
const INACTIVE_RETENTION_SEC = 180 * 24 * 60 * 60;
const RUN_INTERVAL_SEC = 7 * 24 * 60 * 60;
// Per-run caps keep a single weekly invocation inside D1's per-statement
// budget; a larger backlog drains over successive weekly runs. When a pass
// hits its cap the result metadata flags `cappedAtLimit` so the overflow is
// observable rather than silent.
const MAX_DELETIONS_PER_RUN = 100;
const CACHE_LAST_RUN_KEY = "cron:telegram-inactive-cleanup:last-run";

interface CandidateRow {
  chat_id: string;
}

async function loadCandidateChats(db: D1Database, cutoffSec: number, limit: number): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT s.chat_id AS chat_id
         FROM telegram_subscribers s
        WHERE ${INACTIVE_TELEGRAM_SUBSCRIBER_ELIGIBILITY_SQL}
        ORDER BY s.last_active_at ASC
        LIMIT ?`,
    )
    .bind(cutoffSec, limit)
    .all<CandidateRow>();
  return (result.results ?? []).map((row) => row.chat_id);
}

export async function runTelegramInactiveCleanup(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);

  const lastRunRow = await getCache(db, CACHE_LAST_RUN_KEY);
  const lastRunSec = lastRunRow ? (Number.isFinite(Number(lastRunRow.value)) ? Number(lastRunRow.value) : null) : null;
  if (lastRunSec != null && now - lastRunSec < RUN_INTERVAL_SEC) {
    return createCronResult({
      status: "ok",
      itemCount: 0,
      metadata: { skipped: "cache-guard", lastRunSec, nextEligibleSec: lastRunSec + RUN_INTERVAL_SEC },
    });
  }
  throwIfAborted(signal);

  const cutoffSec = now - INACTIVE_RETENTION_SEC;
  const candidates = await loadCandidateChats(db, cutoffSec, MAX_DELETIONS_PER_RUN);
  throwIfAborted(signal);

  const deletionResults = await mapWithConcurrency(
    candidates,
    1,
    async (chatId) => {
      return await purgeInactiveTelegramSubscriber(db, chatId, cutoffSec) ? 1 : 0;
    },
    { signal },
  );
  const deleted = deletionResults.reduce<number>((sum, count) => sum + count, 0);

  await setCache(db, CACHE_LAST_RUN_KEY, String(now));

  return createCronResult({
    status: "ok",
    itemCount: deleted,
    metadata: { cutoffSec, deleted, cappedAtLimit: deleted >= MAX_DELETIONS_PER_RUN },
  });
}
