import type { MinimalD1Database } from "../../lib/minimal-d1";

type RateLimitDb = MinimalD1Database;

export type ApiKeyRequestRateLimitScope =
  | "submission_ip"
  | "submission_email"
  | "verification_ip"
  | "verification_token";

export interface ApiKeyRequestRateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * The two self-serve bucket tables run byte-identical counter logic against
 * different column names, so the algorithm lives here once. The table and
 * timestamp column are a closed literal union because SQLite cannot bind
 * identifiers.
 *
 * Table consolidation is deliberately NOT done here: `api_key_request_rate_limit_v2`
 * carries a CHECK constraint over its `scope` enum, so moving the issuance IP
 * cap onto it would require a migration. That belongs to the destructive D1
 * batch; only the code is shared.
 */
export interface BucketedLimitTable {
  readonly table: "api_key_request_rate_limit_v2" | "api_key_self_serve_issuance_limits";
  readonly lastSeenColumn: "last_seen_at" | "updated_at";
}

const REQUEST_RATE_LIMIT_TABLE: BucketedLimitTable = {
  table: "api_key_request_rate_limit_v2",
  lastSeenColumn: "last_seen_at",
};

export const ISSUANCE_LIMIT_TABLE: BucketedLimitTable = {
  table: "api_key_self_serve_issuance_limits",
  lastSeenColumn: "updated_at",
};

export interface BucketedLimitSlotRequest {
  scope: string;
  subjectHash: string;
  windowSec: number;
  maxCount: number;
  nowSec: number;
}

export interface BucketedLimitSlotResult {
  allowed: boolean;
  retryAfterSec: number;
  bucketStart: number;
}

export function bucketStartFor(nowSec: number, windowSec: number): number {
  return Math.floor(nowSec / windowSec) * windowSec;
}

/**
 * Fixed-window counter with a conditional upsert: the `WHERE count < ?` guard
 * makes the increment itself the admission decision, so a denied caller never
 * inflates the bucket. `allowed` is driven purely by `meta.changes`, which is
 * what keeps both callers fail-closed on a rejected write.
 */
const BUCKETED_LIMIT_TABLE_NAMES = new Set<BucketedLimitTable["table"]>([
  "api_key_request_rate_limit_v2",
  "api_key_self_serve_issuance_limits",
]);
const BUCKETED_LIMIT_LAST_SEEN_COLUMNS = new Set<BucketedLimitTable["lastSeenColumn"]>([
  "last_seen_at",
  "updated_at",
]);

export async function acquireBucketedLimitSlot(
  db: RateLimitDb,
  target: BucketedLimitTable,
  request: BucketedLimitSlotRequest,
): Promise<BucketedLimitSlotResult> {
  if (!BUCKETED_LIMIT_TABLE_NAMES.has(target.table) || !BUCKETED_LIMIT_LAST_SEEN_COLUMNS.has(target.lastSeenColumn)) {
    throw new Error(`unknown bucketed limit target: ${target.table}.${target.lastSeenColumn}`);
  }
  const bucketStart = bucketStartFor(request.nowSec, request.windowSec);
  const result = await db.prepare(
    `INSERT INTO ${target.table} (
       scope,
       subject_hash,
       bucket_start,
       count,
       ${target.lastSeenColumn}
     )
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, subject_hash, bucket_start) DO UPDATE SET
       count = count + 1,
       ${target.lastSeenColumn} = excluded.${target.lastSeenColumn}
     WHERE ${target.table}.count < ?`,
  )
    .bind(request.scope, request.subjectHash, bucketStart, request.nowSec, request.maxCount)
    .run();

  return {
    allowed: (result.meta?.changes ?? 0) > 0,
    retryAfterSec: bucketStart + request.windowSec - request.nowSec,
    bucketStart,
  };
}

export async function checkApiKeyRequestRateLimit(
  db: RateLimitDb,
  scope: ApiKeyRequestRateLimitScope,
  subjectHash: string,
  windowSec: number,
  maxCount: number,
  nowSec: number,
): Promise<ApiKeyRequestRateLimitResult> {
  const { allowed, retryAfterSec } = await acquireBucketedLimitSlot(db, REQUEST_RATE_LIMIT_TABLE, {
    scope,
    subjectHash,
    windowSec,
    maxCount,
    nowSec,
  });
  return { allowed, retryAfterSec };
}

export function pruneOldApiKeyRequestRateLimits(db: RateLimitDb, olderThanSec: number): Promise<void> {
  return db.prepare("DELETE FROM api_key_request_rate_limit_v2 WHERE bucket_start < ?")
    .bind(olderThanSec)
    .run()
    .then(() => undefined);
}
