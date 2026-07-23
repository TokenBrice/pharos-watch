import { bytesToHex } from "./hash";
import { IsolateLocalState } from "./isolate-local-state";

interface RateLimitRunResult {
  meta?: { changes?: number };
}

interface RateLimitStatement {
  bind(...values: unknown[]): RateLimitStatement;
  run(): Promise<RateLimitRunResult>;
  first<T>(): Promise<T | null>;
}

interface RateLimitDb {
  prepare(query: string): RateLimitStatement;
}

export interface FeedbackRateLimitReservation {
  ipHash: string;
  submittedAt: number;
}

const _rl = new IsolateLocalState(() => ({
  feedbackPruneFailures: 0,
  pendingFeedbackPrune: null as Promise<void> | null,
}));

/**
 * Flush any pending rate-limit prune promises.
 * Call via `ctx.waitUntil(flushPendingPrunes())` in the main fetch handler
 * so isolate shutdown doesn't abort in-flight cleanup.
 */
export function flushPendingPrunes(): Promise<void> {
  const promises: Promise<void>[] = [];
  if (_rl.state.pendingFeedbackPrune) {
    promises.push(_rl.state.pendingFeedbackPrune);
    _rl.state.pendingFeedbackPrune = null;
  }
  return promises.length > 0 ? Promise.all(promises).then(() => {}) : Promise.resolve();
}

export function resetRateLimitStateForTests(): void {
  _rl.reset();
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

  _rl.state.pendingFeedbackPrune = db
    .prepare("DELETE FROM feedback_rate_limit WHERE submitted_at < ?")
    .bind(now - 3600)
    .run()
    .then(() => {
      _rl.state.feedbackPruneFailures = 0;
    })
    .catch((e) => {
      _rl.state.feedbackPruneFailures++;
      console.warn(`[feedback] rate-limit prune failed (${_rl.state.feedbackPruneFailures} consecutive):`, e);
    });

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
