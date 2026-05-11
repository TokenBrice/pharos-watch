interface RateLimitRunResult {
  meta?: { changes?: number };
}

interface RateLimitStatement {
  bind(...values: unknown[]): RateLimitStatement;
  run(): Promise<RateLimitRunResult>;
}

interface RateLimitDb {
  prepare(query: string): RateLimitStatement;
}

export type ApiKeyRequestRateLimitScope = "ip" | "email" | "token";

export async function checkApiKeyRequestRateLimit(
  db: RateLimitDb,
  scope: ApiKeyRequestRateLimitScope,
  subjectHash: string,
  windowSec: number,
  maxCount: number,
  nowSec: number,
): Promise<boolean> {
  const bucketStart = Math.floor(nowSec / windowSec) * windowSec;
  const result = await db.prepare(
    `INSERT INTO api_key_request_rate_limit (
       scope,
       subject_hash,
       bucket_start,
       count,
       last_seen_at
     )
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, subject_hash, bucket_start) DO UPDATE SET
       count = count + 1,
       last_seen_at = excluded.last_seen_at
     WHERE api_key_request_rate_limit.count < ?`,
  )
    .bind(scope, subjectHash, bucketStart, nowSec, maxCount)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export function pruneOldApiKeyRequestRateLimits(db: RateLimitDb, olderThanSec: number): Promise<void> {
  return db.prepare("DELETE FROM api_key_request_rate_limit WHERE bucket_start < ?")
    .bind(olderThanSec)
    .run()
    .then(() => undefined);
}
