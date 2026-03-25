import { PUBLIC_API_RATE_LIMIT_SALT_FALLBACK } from "./env";

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

const PUBLIC_API_PRUNE_WINDOW_MULTIPLIER = 10;
let lastPublicApiPruneBucket: number | null = null;
let publicApiPruneFailures = 0;
let feedbackPruneFailures = 0;

function buildRateLimitExceededResponse(retryAfterSec: number): Response {
  const resp = new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
  resp.headers.set("Retry-After", String(Math.max(1, retryAfterSec)));
  return resp;
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

export const CRAWL_BUDGETS = {
  /** Max wall time for CG onchain pool crawl, leaving room for GT-only chains and persistence. */
  COINGECKO_ONCHAIN_MS: 5 * 60 * 1000,
  /** Max wall time for GT pool crawl, leaving headroom for persistence before the Worker hard limit. */
  GECKO_TERMINAL_MS: 3 * 60 * 1000,
  /** Max wall time for DexScreener + CG tickers fallback crawls (shared deadline). */
  FALLBACK_MS: 2 * 60 * 1000,
} as const;

async function hashIpWithSalt(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function checkPublicApiRateLimit(
  db: RateLimitDb,
  ip: string,
  salt?: string,
  limit = 60,
  windowMs = 60_000,
): Promise<Response | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  const bucketStart = nowSec - (nowSec % windowSec);
  const effectiveSalt = (salt ?? "").trim() || PUBLIC_API_RATE_LIMIT_SALT_FALLBACK;

  try {
    const ipHash = await hashIpWithSalt(ip, effectiveSalt);
    const row = await db
      .prepare(
        `INSERT INTO public_api_rate_limit (ip_hash, bucket_start, count, last_seen_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(ip_hash, bucket_start)
         DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at
         RETURNING count`,
      )
      .bind(ipHash, bucketStart, nowSec)
      .first<{ count: number | null }>();

    if (lastPublicApiPruneBucket !== bucketStart) {
      lastPublicApiPruneBucket = bucketStart;
      db.prepare("DELETE FROM public_api_rate_limit WHERE bucket_start < ?")
        .bind(bucketStart - windowSec * PUBLIC_API_PRUNE_WINDOW_MULTIPLIER)
        .run()
        .then(() => { publicApiPruneFailures = 0; })
        .catch((e) => {
          publicApiPruneFailures++;
          console.warn(`[public-api] rate-limit prune failed (${publicApiPruneFailures} consecutive):`, e);
        });
    }

    const count = row?.count ?? 0;
    if (count > limit) {
      return buildRateLimitExceededResponse(bucketStart + windowSec - nowSec);
    }

    return null;
  } catch (err) {
    // D1 failure is transient — allow the request through rather than
    // maintaining an unreliable isolate-local Map with module-scope state.
    console.warn("[public-api] distributed rate limit unavailable, allowing request:", err);
    return null;
  }
}

export async function checkFeedbackRateLimit(
  db: RateLimitDb,
  ip: string,
  salt: string,
  windowSec: number,
  maxSubmissions: number,
): Promise<boolean> {
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
    .bind(
      ipHash,
      now,
      ipHash,
      now - windowSec,
      maxSubmissions,
    )
    .run();
  if ((insertResult.meta?.changes ?? 0) === 0) {
    return false;
  }

  db.prepare("DELETE FROM feedback_rate_limit WHERE submitted_at < ?")
    .bind(now - 3600)
    .run()
    .then(() => { feedbackPruneFailures = 0; })
    .catch((e) => {
      feedbackPruneFailures++;
      console.warn(`[feedback] rate-limit prune failed (${feedbackPruneFailures} consecutive):`, e);
    });

  return true;
}
