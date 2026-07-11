import { BLOCK_STRIKE_WINDOW_SEC } from "../../lib/telegram-constants";
import { logTelegramEvent } from "../../lib/telegram-log";
import { buildInClause, chunkArray, executeAtomicBatch } from "../../lib/db";

/**
 * Two-strike gate for 403 responses. Increments the per-subscriber consecutive
 * block counter and reports whether the aggressive cascade should run.
 *
 * Rules:
 * - First strike: record `consecutive_block_first_at = nowSec`, count = 1, return false.
 * - Subsequent strike within `BLOCK_STRIKE_WINDOW_SEC` of first strike: count >= 2, return true.
 * - Stale first strike (older than window): reset to fresh first strike, return false.
 *
 * On D1 error this returns false so we never call `disableBlockedSubscriber`
 * with stale strike state.
 */
export async function registerSubscriberBlockAndShouldDisable(
  db: D1Database,
  chatId: string,
  nowSec: number,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT consecutive_block_count, consecutive_block_first_at
           FROM telegram_subscribers
          WHERE chat_id = ?`,
      )
      .bind(chatId)
      .first<{ consecutive_block_count: number | null; consecutive_block_first_at: number | null }>();
    const priorCount = row?.consecutive_block_count ?? 0;
    const priorFirstAt = row?.consecutive_block_first_at ?? null;
    const withinWindow = priorFirstAt != null && nowSec - priorFirstAt <= BLOCK_STRIKE_WINDOW_SEC;
    const nextCount = withinWindow ? priorCount + 1 : 1;
    const nextFirstAt = withinWindow ? priorFirstAt : nowSec;
    await db
      .prepare(
        `UPDATE telegram_subscribers
            SET consecutive_block_count = ?,
                consecutive_block_first_at = ?
          WHERE chat_id = ?`,
      )
      .bind(nextCount, nextFirstAt, chatId)
      .run();
    return nextCount >= 2;
  } catch {
    logTelegramEvent({
      message: "Failed to register block strike",
      action: "register-block-strike",
      module: "telegram-pending-lifecycle",
    });
    return false;
  }
}

export interface BlockedSubscriberCascadeResult {
  disabled: boolean;
  failed: boolean;
}

export async function registerSubscriberBlockAndMaybeDisable(
  db: D1Database,
  chatId: string,
  nowSec: number,
): Promise<BlockedSubscriberCascadeResult> {
  const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, chatId, nowSec);
  if (!shouldDisable) return { disabled: false, failed: false };

  if (await disableBlockedSubscriber(db, chatId)) {
    return { disabled: true, failed: false };
  }
  return { disabled: false, failed: true };
}

export async function handleBlockedChat(
  db: D1Database,
  chatId: string,
  nowSec: number,
  blockedChatsThisRun: Set<string>,
): Promise<BlockedSubscriberCascadeResult> {
  if (blockedChatsThisRun.has(chatId)) return { disabled: false, failed: false };
  blockedChatsThisRun.add(chatId);
  return registerSubscriberBlockAndMaybeDisable(db, chatId, nowSec);
}

/** Reset the consecutive-block counter on any successful send. */
export async function resetSubscriberBlockCount(db: D1Database, chatId: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE telegram_subscribers
            SET consecutive_block_count = 0,
                consecutive_block_first_at = NULL
          WHERE chat_id = ?
            AND (consecutive_block_count <> 0 OR consecutive_block_first_at IS NOT NULL)`,
      )
      .bind(chatId)
      .run();
  } catch {
    logTelegramEvent({
      message: "Failed to reset block count",
      action: "reset-block-count",
      module: "telegram-pending-lifecycle",
    });
  }
}

export async function flushChatSuccessResets(
  db: D1Database,
  chatIds: Iterable<string>,
): Promise<void> {
  const unique = Array.from(new Set(chatIds));
  if (unique.length === 0) return;
  for (const chunk of chunkArray(unique)) {
    const inClause = buildInClause(chunk);
    try {
      await db
        .prepare(
          `UPDATE telegram_subscribers
              SET consecutive_block_count = 0,
                  consecutive_block_first_at = NULL
            WHERE chat_id IN (${inClause.sql})
              AND (consecutive_block_count <> 0 OR consecutive_block_first_at IS NOT NULL)`,
        )
        .bind(...inClause.binds)
        .run();
    } catch {
      logTelegramEvent({
        message: "Failed to batch reset block counts",
        action: "reset-block-count-batch",
        module: "telegram-pending-lifecycle",
        affectedChats: chunk.length,
      });
    }
  }
}

export async function disableBlockedSubscriber(db: D1Database, chatId: string): Promise<boolean> {
  try {
    await executeAtomicBatch(db, [
      db
        .prepare(
          `UPDATE telegram_subscribers
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0,
                  alert_reserve=0,
                  alert_freeze=0,
                  global_alert_dews=0,
                  global_alert_depeg=0,
                  global_alert_safety=0,
                  global_alert_launch=0,
                  global_alert_reserve=0,
                  global_alert_freeze=0,
                  global_depeg_worsening_bps_step=NULL,
                  preference_generation=preference_generation + 1
            WHERE chat_id=?`,
        )
        .bind(chatId),
      db
        .prepare(
          `UPDATE telegram_subscriptions
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0,
                  alert_reserve=0,
                  alert_freeze=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
      db
        .prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id=?")
        .bind(chatId),
    ]);
    return true;
  } catch {
    logTelegramEvent({
      message: "Failed to disable blocked subscriber",
      action: "disable-blocked-subscriber",
      module: "telegram-pending-lifecycle",
    });
    return false;
  }
}
