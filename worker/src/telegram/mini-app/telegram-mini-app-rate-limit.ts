import { bytesToHex } from "../../lib/hash";

export const TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT = 12;
export const TELEGRAM_MINI_APP_MUTATION_BURST_WINDOW_SEC = 30;

const MUTATION_BURST_KEY_PREFIX = "telegram:mini-app-mutation-burst:";
const encoder = new TextEncoder();

export interface TelegramMiniAppMutationBurstResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Atomically admits a bounded burst of authenticated Mini App writes. The
 * window begins with the first admitted write rather than at a wall-clock
 * boundary, which avoids a double burst across adjacent fixed buckets.
 * Only time-scoped HMAC identities reach D1; /forget may erase all chat-owned
 * keys without resetting admission. Look back one epoch to carry an anchored
 * window across the epoch boundary, never beyond its original deadline.
 */
export async function acquireTelegramMiniAppMutationBurst(
  db: D1Database,
  input: {
    userId: string;
    botToken: string;
    nowSec: number;
    limit?: number;
    windowSec?: number;
  },
): Promise<TelegramMiniAppMutationBurstResult> {
  const limit = Math.max(1, Math.floor(input.limit ?? TELEGRAM_MINI_APP_MUTATION_BURST_LIMIT));
  const windowSec = Math.min(TELEGRAM_MINI_APP_MUTATION_BURST_WINDOW_SEC,
    Math.max(1, Math.floor(input.windowSec ?? TELEGRAM_MINI_APP_MUTATION_BURST_WINDOW_SEC)));
  const epoch = Math.floor(input.nowSec / windowSec);
  const secret = await crypto.subtle.importKey("raw", encoder.encode(input.botToken),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const keys = await Promise.all([epoch, epoch - 1].map(async (identityEpoch) => {
    const digest = await crypto.subtle.sign("HMAC", secret,
      encoder.encode(`${MUTATION_BURST_KEY_PREFIX}${windowSec}:${identityEpoch}:${input.userId}`));
    return `${MUTATION_BURST_KEY_PREFIX}anon:${bytesToHex(new Uint8Array(digest))}`;
  }));
  const [key, previousKey] = keys;
  const eligibleBefore = input.nowSec - windowSec;
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at)
       VALUES (
         COALESCE((SELECT key FROM cache
                    WHERE key IN (?, ?) AND updated_at > ?
                    ORDER BY updated_at DESC LIMIT 1), ?),
         '1', ?)
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
    .bind(key, previousKey, eligibleBefore, key, input.nowSec,
      eligibleBefore, eligibleBefore, eligibleBefore, limit)
    .run();

  const changes = Number(result.meta?.changes ?? 0);
  if (Number.isFinite(changes) && changes > 0) {
    return { allowed: true, retryAfterSec: 0 };
  }

  const row = await db
    .prepare(`SELECT updated_at FROM cache
               WHERE key IN (?, ?) AND updated_at > ?
               ORDER BY updated_at DESC LIMIT 1`)
    .bind(key, previousKey, eligibleBefore)
    .first<{ updated_at: number | string | null }>();
  const windowStartedAt = row?.updated_at == null ? Number.NaN : Number(row.updated_at);
  const retryAfterSec = Number.isFinite(windowStartedAt)
    ? Math.max(1, Math.min(windowSec, windowStartedAt + windowSec - input.nowSec))
    : windowSec;
  return { allowed: false, retryAfterSec };
}
