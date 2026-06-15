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

export type ApiKeyRequestRateLimitScope =
  | "submission_ip"
  | "submission_email"
  | "verification_ip"
  | "verification_token";

export interface ApiKeyRequestRateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

export async function checkApiKeyRequestRateLimit(
  db: RateLimitDb,
  scope: ApiKeyRequestRateLimitScope,
  subjectHash: string,
  windowSec: number,
  maxCount: number,
  nowSec: number,
): Promise<ApiKeyRequestRateLimitResult> {
  const bucketStart = Math.floor(nowSec / windowSec) * windowSec;
  const result = await db.prepare(
    `INSERT INTO api_key_request_rate_limit_v2 (
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
     WHERE api_key_request_rate_limit_v2.count < ?`,
  )
    .bind(scope, subjectHash, bucketStart, nowSec, maxCount)
    .run();

  const retryAfterSec = bucketStart + windowSec - nowSec;
  return {
    allowed: (result.meta?.changes ?? 0) > 0,
    retryAfterSec,
  };
}

export function pruneOldApiKeyRequestRateLimits(db: RateLimitDb, olderThanSec: number): Promise<void> {
  return db.prepare("DELETE FROM api_key_request_rate_limit_v2 WHERE bucket_start < ?")
    .bind(olderThanSec)
    .run()
    .then(() => undefined);
}
