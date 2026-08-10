import { SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE, SELF_SERVE_MAX_CREATIONS_PER_IP_24H } from "@shared/lib/ops-limits";
import { clearApiKeyCache } from "../../lib/api-key-core";
import { logWorkerEvent } from "../../lib/structured-log";
import { normalizeOptionalText } from "./request";
import { ISSUANCE_LIMIT_TABLE, acquireBucketedLimitSlot, bucketStartFor } from "./rate-limit";
import type {
  ApiKeyRequestDb,
  ApiKeyRequestRow,
  ParsedApiKeySelfServeRequest,
} from "./types";

const ORPHAN_CLAIM_GRACE_SEC = 10 * 60;
const ISSUANCE_LOCK_STALE_SEC = 10 * 60;
const ISSUANCE_IP_CAP_WINDOW_SEC = 24 * 60 * 60;
const ISSUANCE_IP_CAP_SCOPE = "submission_ip_daily" as const;

export async function insertPendingRequest(
  db: ApiKeyRequestDb,
  input: {
    parsed: ParsedApiKeySelfServeRequest;
    requestId: string;
    normalizedEmail: string;
    emailHash: string;
    ipHash: string;
    userAgentHash: string | null;
    tokenHash: string;
    verificationExpiresAt: number;
    selfServeExpiresAt: number;
    nowSec: number;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO api_key_requests (
       request_id,
       status,
       normalized_email,
       email_hash,
       email_verified,
       requester_name,
       organization,
       project_url,
       use_case,
       expected_cadence,
       expected_volume,
       accepted_terms,
       self_serve_rate_limit_per_minute,
       self_serve_expires_at,
       ip_hash,
       user_agent_hash,
       verification_token_hash,
       verification_sent_at,
       verification_expires_at,
       created_at,
       updated_at
     )
     VALUES (?, 'pending_verification', ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      input.requestId,
      input.normalizedEmail,
      input.emailHash,
      normalizeOptionalText(input.parsed.requesterName),
      normalizeOptionalText(input.parsed.organization),
      normalizeOptionalText(input.parsed.projectUrl),
      input.parsed.useCase.trim(),
      input.parsed.expectedCadence,
      normalizeOptionalText(input.parsed.expectedVolume),
      SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
      input.selfServeExpiresAt,
      input.ipHash,
      input.userAgentHash,
      input.tokenHash,
      input.verificationExpiresAt,
      input.nowSec,
      input.nowSec,
    )
    .run();
}

export async function acquireEmailClaim(
  db: ApiKeyRequestDb,
  input: {
    emailHash: string;
    normalizedEmail: string;
    requestId: string;
    nowSec: number;
  },
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO api_key_self_serve_email_claims (
       email_hash,
       normalized_email,
       api_key_id,
       request_id,
       status,
       claimed_at,
       released_at,
       updated_at
     )
     VALUES (?, ?, NULL, ?, 'pending_verification', ?, NULL, ?)
     ON CONFLICT(email_hash) DO UPDATE SET
       normalized_email = excluded.normalized_email,
       api_key_id = NULL,
       request_id = excluded.request_id,
       status = 'pending_verification',
       claimed_at = excluded.claimed_at,
       released_at = NULL,
       updated_at = excluded.updated_at
     WHERE api_key_self_serve_email_claims.status = 'released'`,
  )
    .bind(input.emailHash, input.normalizedEmail, input.requestId, input.nowSec, input.nowSec)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function releaseExpiredPendingClaim(db: ApiKeyRequestDb, emailHash: string, nowSec: number): Promise<void> {
  await db.prepare(
    `UPDATE api_key_self_serve_email_claims
     SET status = 'released', released_at = ?, updated_at = ?
     WHERE email_hash = ?
       AND status = 'pending_verification'
       AND EXISTS (
         SELECT 1 FROM api_key_requests
         WHERE api_key_requests.request_id = api_key_self_serve_email_claims.request_id
           AND api_key_requests.verification_expires_at < ?
       )`,
  )
    .bind(nowSec, nowSec, emailHash, nowSec)
    .run();
}

export async function releaseOrphanPendingClaims(db: ApiKeyRequestDb, nowSec: number): Promise<void> {
  const result = await db.prepare(
    `UPDATE api_key_self_serve_email_claims
     SET status = 'released', released_at = ?, updated_at = ?
     WHERE status = 'pending_verification'
       AND claimed_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM api_key_requests
         WHERE api_key_requests.request_id = api_key_self_serve_email_claims.request_id
       )`,
  )
    .bind(nowSec, nowSec, nowSec - ORPHAN_CLAIM_GRACE_SEC)
    .run();
  const released = result.meta?.changes ?? 0;
  if (released > 0) {
    logWorkerEvent({
      scope: "api",
      level: "info",
      event: "api_key_request_orphan_claims_released",
      route: "api-key-requests",
      source: "api_key_self_serve_email_claims",
      message: `Released ${released} orphan pending self-serve email claim(s)`,
      metadata: { released },
    });
  }
}

export async function releaseInactiveIssuedClaim(db: ApiKeyRequestDb, emailHash: string, nowSec: number): Promise<void> {
  await db.prepare(
    `UPDATE api_key_self_serve_email_claims
     SET status = 'released', released_at = ?, updated_at = ?
     WHERE email_hash = ?
       AND status = 'issued'
       AND EXISTS (
         SELECT 1 FROM api_keys
         WHERE api_keys.id = api_key_self_serve_email_claims.api_key_id
           AND (
             api_keys.is_active = 0
             OR (api_keys.expires_at IS NOT NULL AND api_keys.expires_at <= ?)
           )
       )`,
  )
    .bind(nowSec, nowSec, emailHash, nowSec)
    .run();
}

export async function releaseEmailClaim(db: ApiKeyRequestDb, emailHash: string, requestId: string, nowSec: number): Promise<void> {
  await db.prepare(
    `UPDATE api_key_self_serve_email_claims
     SET status = 'released', released_at = ?, updated_at = ?
     WHERE email_hash = ? AND request_id = ?`,
  )
    .bind(nowSec, nowSec, emailHash, requestId)
    .run();
}

export async function selectPendingRequestByTokenHash(db: ApiKeyRequestDb, tokenHash: string): Promise<ApiKeyRequestRow | null> {
  return db.prepare(
    `SELECT *
     FROM api_key_requests
     WHERE verification_token_hash = ?
     LIMIT 1`,
  )
    .bind(tokenHash)
    .first<ApiKeyRequestRow>();
}

export async function selectCurrentPendingClaim(
  db: ApiKeyRequestDb,
  emailHash: string,
  requestId: string,
): Promise<{ email_hash: string } | null> {
  return db.prepare(
    `SELECT email_hash
     FROM api_key_self_serve_email_claims
     WHERE email_hash = ?
       AND request_id = ?
       AND status = 'pending_verification'
     LIMIT 1`,
  )
    .bind(emailHash, requestId)
    .first<{ email_hash: string }>();
}

export async function lockVerificationForIssuance(
  db: ApiKeyRequestDb,
  requestId: string,
  tokenHash: string,
  nowSec: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE api_key_requests
     SET email_verified = 1,
       issuance_locked_at = ?,
       updated_at = ?
     WHERE request_id = ?
       AND status = 'pending_verification'
       AND verification_token_hash = ?
       AND verification_expires_at >= ?
       AND api_key_id IS NULL
       AND (issuance_locked_at IS NULL OR issuance_locked_at < ?)`,
  )
    .bind(nowSec, nowSec, requestId, tokenHash, nowSec, nowSec - ISSUANCE_LOCK_STALE_SEC)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function releaseVerificationLock(db: ApiKeyRequestDb, requestId: string, nowSec: number): Promise<void> {
  await db.prepare(
    `UPDATE api_key_requests
     SET issuance_locked_at = NULL,
       updated_at = ?
     WHERE request_id = ?
       AND status = 'pending_verification'
       AND api_key_id IS NULL`,
  )
    .bind(nowSec, requestId)
    .run();
}

export async function acquireIssuanceIpCap(
  db: ApiKeyRequestDb,
  ipHash: string,
  nowSec: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const { allowed, retryAfterSec } = await acquireBucketedLimitSlot(db, ISSUANCE_LIMIT_TABLE, {
    scope: ISSUANCE_IP_CAP_SCOPE,
    subjectHash: ipHash,
    windowSec: ISSUANCE_IP_CAP_WINDOW_SEC,
    maxCount: SELF_SERVE_MAX_CREATIONS_PER_IP_24H,
    nowSec,
  });
  // The shared limiter reports the raw remaining window; this caller keeps its
  // 1s floor so a request landing on the bucket boundary still gets a usable
  // Retry-After.
  return { allowed, retryAfterSec: Math.max(1, retryAfterSec) };
}

export async function releaseIssuanceIpCap(db: ApiKeyRequestDb, ipHash: string, nowSec: number): Promise<void> {
  const bucketStart = bucketStartFor(nowSec, ISSUANCE_IP_CAP_WINDOW_SEC);
  await db.prepare(
    `UPDATE api_key_self_serve_issuance_limits
     SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END,
       updated_at = ?
     WHERE scope = ?
       AND subject_hash = ?
       AND bucket_start = ?`,
  )
    .bind(nowSec, ISSUANCE_IP_CAP_SCOPE, ipHash, bucketStart)
    .run();
}

export async function linkRequestForIssuance(
  db: ApiKeyRequestDb,
  requestId: string,
  tokenHash: string,
  apiKeyId: number,
  expiresAt: number | null,
  nowSec: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE api_key_requests
     SET api_key_id = ?,
       email_verified = 1,
       self_serve_expires_at = ?,
       updated_at = ?
     WHERE request_id = ?
       AND status = 'pending_verification'
       AND verification_token_hash = ?
       AND email_verified = 1
       AND api_key_id IS NULL
       AND issuance_locked_at IS NOT NULL`,
  )
    .bind(apiKeyId, expiresAt, nowSec, requestId, tokenHash)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function finalizeRequestIssued(
  db: ApiKeyRequestDb,
  requestId: string,
  tokenHash: string,
  apiKeyId: number,
  nowSec: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE api_key_requests
     SET status = 'issued',
       verification_token_hash = NULL,
       issuance_locked_at = NULL,
       issued_at = ?,
       updated_at = ?
     WHERE request_id = ?
       AND status = 'pending_verification'
       AND verification_token_hash = ?
       AND email_verified = 1
       AND api_key_id = ?
       AND issuance_locked_at IS NOT NULL`,
  )
    .bind(nowSec, nowSec, requestId, tokenHash, apiKeyId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markClaimIssued(
  db: ApiKeyRequestDb,
  emailHash: string,
  requestId: string,
  apiKeyId: number,
  nowSec: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE api_key_self_serve_email_claims
     SET api_key_id = ?,
       status = 'issued',
       updated_at = ?
     WHERE email_hash = ?
       AND request_id = ?
       AND status = 'pending_verification'`,
  )
    .bind(apiKeyId, nowSec, emailHash, requestId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markRequestExpired(db: ApiKeyRequestDb, requestId: string, nowSec: number): Promise<void> {
  await db.prepare(
    `UPDATE api_key_requests
     SET status = 'expired',
       verification_token_hash = NULL,
       updated_at = ?
     WHERE request_id = ? AND status = 'pending_verification'`,
  )
    .bind(nowSec, requestId)
    .run();
}

export async function markRequestBlockedAndReleaseClaim(
  db: ApiKeyRequestDb,
  row: ApiKeyRequestRow,
  nowSec: number,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE api_key_requests
     SET status = 'blocked',
       verification_token_hash = NULL,
       issuance_locked_at = NULL,
       updated_at = ?
     WHERE request_id = ?
       AND status = 'pending_verification'`,
  )
    .bind(nowSec, row.request_id)
    .run();
  if ((result.meta?.changes ?? 0) > 0) {
    await releaseEmailClaim(db, row.email_hash, row.request_id, nowSec);
  }
}

export interface IssuedKeyFailureCompensation {
  keyDeactivated: boolean;
  requestBlocked: boolean;
}

async function markIssuanceFailureBlockedAndReleaseClaim(
  db: ApiKeyRequestDb,
  row: ApiKeyRequestRow,
  nowSec: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE api_key_requests
     SET status = 'blocked',
       verification_token_hash = NULL,
       issuance_locked_at = NULL,
       updated_at = ?
     WHERE request_id = ?
       AND status IN ('pending_verification', 'issued')`,
  )
    .bind(nowSec, row.request_id)
    .run();
  const blocked = (result.meta?.changes ?? 0) > 0;
  if (blocked) {
    await releaseEmailClaim(db, row.email_hash, row.request_id, nowSec);
  }
  return blocked;
}

export async function compensateIssuedKeyFailure(
  db: ApiKeyRequestDb,
  apiKeyId: number,
  keyPrefix: string,
  row: ApiKeyRequestRow,
  nowSec: number,
): Promise<IssuedKeyFailureCompensation> {
  let keyDeactivated = false;
  let requestBlocked = false;
  try {
    const result = await db.prepare("UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?")
      .bind(nowSec, apiKeyId)
      .run();
    keyDeactivated = (result.meta?.changes ?? 0) > 0;
    clearApiKeyCache(keyPrefix);
  } catch (error) {
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "api_key_request_compensation_deactivate_failed",
      route: "api-key-requests",
      source: "api_keys",
      message: "Failed to deactivate key during issuance compensation",
      error,
      metadata: { requestId: row.request_id, apiKeyId },
    });
  }
  try {
    requestBlocked = await markIssuanceFailureBlockedAndReleaseClaim(db, row, nowSec);
  } catch (error) {
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "api_key_request_compensation_block_failed",
      route: "api-key-requests",
      source: "api_key_requests",
      message: "Failed to mark request blocked during issuance compensation",
      error,
      metadata: { requestId: row.request_id, apiKeyId },
    });
  }
  return { keyDeactivated, requestBlocked };
}
