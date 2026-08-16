import { logWorkerEventArgs } from "./structured-log";
import { bytesToHex } from "./hash";
import type { MinimalD1Database } from "./minimal-d1";

type RateLimitDb = MinimalD1Database;

export interface FeedbackRateLimitReservation {
  ipHash: string;
  submittedAt: number;
}

/** Centralized rate-limit and crawl-budget constants for external APIs */
export const RATE_LIMITS = {
  /** CoinGecko onchain API: ~240 req/min paid plan, conservative with headroom */
  COINGECKO_ONCHAIN_MS: 250,
  /** CoinGecko backfill: 500 req/min budget → 200ms between calls */
  COINGECKO_BACKFILL_MS: 200,
  /** DexScreener: ~60 req/min free tier */
  DEXSCREENER_MS: 1100,
  /** GeckoTerminal: 30 req/min = 1 every 2s */
  GECKO_TERMINAL_MS: 2000,
  /** Stellar public Horizon: 3,600 req/hour = at most 1 request/second */
  HORIZON_MS: 1000,
} as const;

async function hashIpWithSalt(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hashBuffer)).slice(0, 32);
}

export async function reserveFeedbackRateLimit(
  db: RateLimitDb,
  ip: string,
  salt: string,
  windowSec: number,
  maxSubmissions: number,
  execCtx?: ExecutionContext,
): Promise<FeedbackRateLimitReservation | null> {
  const now = Math.floor(Date.now() / 1000);
  const ipHash = await hashIpWithSalt(ip, salt);

  const insertResult = await db
    .prepare(
      `INSERT INTO feedback_rate_limit (ip_hash, submitted_at)
       SELECT ?, ?
       WHERE (
         SELECT COUNT(*) FROM feedback_rate_limit
         WHERE ip_hash = ? AND submitted_at > ?
       ) < ?`,
    )
    .bind(ipHash, now, ipHash, now - windowSec, maxSubmissions)
    .run();
  if ((insertResult.meta?.changes ?? 0) === 0) {
    return null;
  }

  // Handed straight to the request lifetime instead of parked in module state
  // for a later flush: `waitUntil` already keeps the isolate alive for it.
  execCtx?.waitUntil(
    db
      .prepare("DELETE FROM feedback_rate_limit WHERE submitted_at < ?")
      .bind(now - 3600)
      .run()
      .then(() => {})
      .catch((e) => {
        logWorkerEventArgs("lib", "warn", "[feedback] rate-limit prune failed:", e);
      }),
  );

  return { ipHash, submittedAt: now };
}

export async function releaseFeedbackRateLimit(
  db: RateLimitDb,
  reservation: FeedbackRateLimitReservation,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM feedback_rate_limit
        WHERE rowid = (
          SELECT rowid
            FROM feedback_rate_limit
           WHERE ip_hash = ? AND submitted_at = ?
           LIMIT 1
        )`,
    )
    .bind(reservation.ipHash, reservation.submittedAt)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}
