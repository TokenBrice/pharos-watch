export const TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT = 12;
export const TELEGRAM_MINI_APP_MUTATION_BURST_WINDOW_SEC = 30;

const MUTATION_BURST_KEY_PREFIX = "telegram:mini-app-mutation-burst:";

export interface TelegramMiniAppMutationBurstResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Atomically admits a bounded burst of authenticated Mini App writes. The
 * window begins with the first admitted write rather than at a wall-clock
 * boundary, which avoids a double burst across adjacent fixed buckets.
 */
export async function acquireTelegramMiniAppMutationBurst(
  db: D1Database,
  input: {
    userId: string;
    nowSec: number;
    limit?: number;
    windowSec?: number;
  },
): Promise<TelegramMiniAppMutationBurstResult> {
  const limit = Math.max(1, Math.floor(input.limit ?? TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT));
  const windowSec = Math.max(1, Math.floor(input.windowSec ?? TELEGRAM_MINI_APP_MUTATION_BURST_WINDOW_SEC));
  const key = `${MUTATION_BURST_KEY_PREFIX}${input.userId}`;
  const eligibleBefore = input.nowSec - windowSec;
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE
           WHEN cache.updated_at <= ? THEN '1'
           ELSE CAST(CAST(cache.value AS INTEGER) + 1 AS TEXT)
         END,
         updated_at = CASE
           WHEN cache.updated_at <= ? THEN excluded.updated_at
           ELSE cache.updated_at
         END
       WHERE cache.updated_at <= ?
          OR CAST(cache.value AS INTEGER) < ?`,
    )
    .bind(key, input.nowSec, eligibleBefore, eligibleBefore, eligibleBefore, limit)
    .run();

  const changes = Number(result.meta?.changes ?? 0);
  if (Number.isFinite(changes) && changes > 0) {
    return { allowed: true, retryAfterSec: 0 };
  }

  const row = await db
    .prepare("SELECT updated_at FROM cache WHERE key = ?")
    .bind(key)
    .first<{ updated_at: number | string | null }>();
  const windowStartedAt = row?.updated_at == null ? Number.NaN : Number(row.updated_at);
  const retryAfterSec = Number.isFinite(windowStartedAt)
    ? Math.max(1, Math.min(windowSec, windowStartedAt + windowSec - input.nowSec))
    : windowSec;
  return { allowed: false, retryAfterSec };
}
