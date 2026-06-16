import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db-cache";
import { sendToChat } from "../lib/telegram";
import { buildTelegramMiniAppUrl } from "../lib/telegram-webhook-registration";
import { recordTelegramUsageEvent } from "../lib/telegram-usage-analytics";
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
 *
 * Before the prune pass, a "warn-only" sub-pass nudges subscribers who are
 * 170-179 days idle and still have active subscriptions or preset follows
 * so an engaged-but-quiet user gets one warning before their row would be
 * removed at day 180. The warning is gated by a per-chat 30-day cache marker
 * so the same chat cannot receive a second nudge within the same warning
 * window. The sub-pass is a no-op when `botToken` is empty so unit tests and
 * the pre-wire production call site stay safe.
 */
const INACTIVE_RETENTION_SEC = 180 * 24 * 60 * 60;
const WARN_WINDOW_START_SEC = 170 * 24 * 60 * 60;
const WARN_MARKER_TTL_SEC = 30 * 24 * 60 * 60;
const RUN_INTERVAL_SEC = 7 * 24 * 60 * 60;
const MAX_DELETIONS_PER_RUN = 100;
const MAX_WARNINGS_PER_RUN = 100;
const CACHE_LAST_RUN_KEY = "cron:telegram-inactive-cleanup:last-run";
const WARN_CACHE_KEY_PREFIX = "telegram:re-engagement-warned:";

interface CandidateRow {
  chat_id: string;
}

interface WarningCandidateRow {
  chat_id: string;
  last_active_at: number;
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

async function loadWarningCandidates(
  db: D1Database,
  warnWindowOlderBound: number,
  warnWindowNewerBound: number,
  limit: number,
): Promise<WarningCandidateRow[]> {
  const result = await db
    .prepare(
      `SELECT DISTINCT s.chat_id AS chat_id, s.last_active_at AS last_active_at
         FROM telegram_subscribers s
         LEFT JOIN telegram_subscriptions sub ON sub.chat_id = s.chat_id
         LEFT JOIN telegram_preset_subscriptions ps ON ps.chat_id = s.chat_id
        WHERE s.last_active_at >= ?
          AND s.last_active_at < ?
          AND (sub.chat_id IS NOT NULL OR ps.chat_id IS NOT NULL)
        ORDER BY s.last_active_at ASC
        LIMIT ?`,
    )
    .bind(warnWindowOlderBound, warnWindowNewerBound, limit)
    .all<WarningCandidateRow>();
  return result.results ?? [];
}

function buildWarningText(): string {
  return (
    "You’ve been quiet for 170 days. Pharos will delete your subscriber row in 10 days for inactivity. "
    + "Open the Mini App or send /list to stay subscribed."
  );
}

function buildWarningReplyMarkup(): { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> } {
  return {
    inline_keyboard: [[{ text: "Stay subscribed", web_app: { url: buildTelegramMiniAppUrl("home") } }]],
  };
}

async function isAlreadyWarned(db: D1Database, chatId: string, nowSec: number): Promise<boolean> {
  const cached = await getCache(db, `${WARN_CACHE_KEY_PREFIX}${chatId}`);
  if (!cached) return false;
  return nowSec - cached.updatedAt < WARN_MARKER_TTL_SEC;
}

async function markWarned(db: D1Database, chatId: string, nowSec: number): Promise<void> {
  await setCache(db, `${WARN_CACHE_KEY_PREFIX}${chatId}`, String(nowSec));
}

interface WarningPassResult {
  attempted: number;
  warned: number;
  blocked: number;
  failed: number;
  skippedAlreadyWarned: number;
}

async function runWarningPass(
  db: D1Database,
  botToken: string,
  now: number,
  signal: AbortSignal | undefined,
): Promise<WarningPassResult> {
  const warnWindowNewerBound = now - WARN_WINDOW_START_SEC;
  const warnWindowOlderBound = now - INACTIVE_RETENTION_SEC;
  const candidates = await loadWarningCandidates(db, warnWindowOlderBound, warnWindowNewerBound, MAX_WARNINGS_PER_RUN);
  throwIfAborted(signal);

  let warned = 0;
  let blocked = 0;
  let failed = 0;
  let skippedAlreadyWarned = 0;

  await runBoundedQueue({
    items: candidates,
    concurrency: 1,
    signal,
    worker: async (row) => {
      if (await isAlreadyWarned(db, row.chat_id, now)) {
        skippedAlreadyWarned += 1;
        return;
      }
      const result = await sendToChat(row.chat_id, buildWarningText(), botToken, {
        disableWebPagePreview: true,
        replyMarkup: buildWarningReplyMarkup(),
        signal,
      });
      if (result.ok) {
        await markWarned(db, row.chat_id, now);
        await recordTelegramUsageEvent(db, {
          nowSec: now,
          eventType: "re_engagement_warning",
          outcome: "sent",
        });
        warned += 1;
        return;
      }
      if (result.blocked) {
        // Treat 403 like other crons: persist the marker so we don't retry the
        // same blocked chat every cron run during the warning window.
        await markWarned(db, row.chat_id, now);
        await recordTelegramUsageEvent(db, {
          nowSec: now,
          eventType: "re_engagement_warning",
          outcome: "blocked",
          failureClass: result.errorClass ?? "blocked",
        });
        blocked += 1;
        return;
      }
      // Retryable / permanent non-block failure: leave marker absent so the
      // next run can try again.
      await recordTelegramUsageEvent(db, {
        nowSec: now,
        eventType: "re_engagement_warning",
        outcome: "failure",
        failureClass: result.errorClass ?? "unknown",
      });
      failed += 1;
    },
  });

  return {
    attempted: candidates.length,
    warned,
    blocked,
    failed,
    skippedAlreadyWarned,
  };
}

async function deleteChatCascade(db: D1Database, chatId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_alerts WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    db.prepare("DELETE FROM telegram_subscribers WHERE chat_id = ?").bind(chatId),
  ]);
}

export async function runTelegramInactiveCleanup(
  db: D1Database,
  signal?: AbortSignal,
  botToken?: string | null,
): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);

  const lastRunRow = await getCache(db, CACHE_LAST_RUN_KEY);
  const lastRunSec = lastRunRow ? (Number.isFinite(Number(lastRunRow.value)) ? Number(lastRunRow.value) : null) : null;
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

  // Warn-only sub-pass: nudge subscribers 170-179 days idle who still have
  // active subscriptions or preset follows. No-op when no botToken is wired
  // (existing prod call site has not been updated yet; tests opt in).
  const warningPass = botToken && botToken.length > 0
    ? await runWarningPass(db, botToken, now, signal)
    : null;
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

  await setCache(db, CACHE_LAST_RUN_KEY, String(now));

  return {
    status: "ok",
    itemCount: deleted,
    metadata: JSON.stringify({
      cutoffSec,
      deleted,
      cappedAtLimit: deleted >= MAX_DELETIONS_PER_RUN,
      ...(warningPass
        ? {
            warningPass: {
              attempted: warningPass.attempted,
              warned: warningPass.warned,
              blocked: warningPass.blocked,
              failed: warningPass.failed,
              skippedAlreadyWarned: warningPass.skippedAlreadyWarned,
            },
          }
        : {}),
    }),
  };
}
