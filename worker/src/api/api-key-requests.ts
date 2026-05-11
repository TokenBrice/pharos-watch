import type {
  ApiKeySelfServeAdminMutationResponse,
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServeRequestAdminListResponse,
  ApiKeySelfServeRequestAdminSummary,
  ApiKeySelfServeStatus,
} from "@shared/types";
import {
  SELF_SERVE_API_KEY_EXPIRY_SEC,
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_DEPENDENCY_RETRY_AFTER_SEC,
  SELF_SERVE_MAX_CREATIONS_PER_IP_24H,
  SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_EMAIL_PER_DAY,
  SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_IP_PER_HOUR,
  SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_IP_10M,
  SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_TOKEN_10M,
  SELF_SERVE_VERIFICATION_TOKEN_TTL_SEC,
} from "@shared/lib/ops-limits";
import { createGitHubIssue } from "./feedback/github";
import { createTrustedApiKey } from "../lib/api-key-admin";
import {
  clearApiKeyCache,
  getNowSec,
  recordApiKeyAudit,
} from "../lib/api-key-core";
import {
  errorResponse,
  jsonResponse,
  parseOptionalPositiveIntegerParam,
  parseOptionalEnumParam,
} from "../lib/api-utils";
import { adminErrorResponse, adminJsonResponse, runAdminRoute } from "../lib/route-wrappers";
import { sendVerificationEmail } from "./api-key-requests/email";
import { checkApiKeyRequestRateLimit, pruneOldApiKeyRequestRateLimits } from "./api-key-requests/rate-limit";
import {
  buildVerificationUrl,
  createRequestId,
  createVerificationToken,
  hashClientIp,
  hashForLookup,
  hashUserAgent,
  normalizeOptionalText,
  normalizeSelfServeEmail,
  parseSelfServeRequest,
  parseSelfServeVerifyRequest,
  requireInitialSelfServeEnv,
  requireVerifySelfServeEnv,
  validateIntendedEndpoints,
} from "./api-key-requests/request";
import type {
  ApiKeySelfServeEnv,
  ParsedApiKeySelfServeRequest,
} from "./api-key-requests/types";

interface StatementRunResult {
  meta?: { changes?: number };
}

interface StatementResult<T> {
  results?: T[];
}

interface ApiKeyRequestStatement {
  bind(...values: unknown[]): ApiKeyRequestStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<StatementResult<T>>;
  run(): Promise<StatementRunResult>;
}

interface ApiKeyRequestDb {
  prepare(query: string): ApiKeyRequestStatement;
}

interface ApiKeyRequestRow {
  request_id: string;
  api_key_id: number | null;
  status: ApiKeySelfServeStatus;
  normalized_email: string;
  email_hash: string;
  email_verified: number;
  requester_name: string | null;
  organization: string | null;
  project_url: string | null;
  use_case: string;
  intended_endpoints_json: string | null;
  expected_cadence: string | null;
  expected_volume: string | null;
  accepted_terms: number;
  self_serve_rate_limit_per_minute: number;
  self_serve_expires_at: number | null;
  ip_hash: string;
  user_agent_hash: string | null;
  risk_score: number;
  risk_reasons_json: string | null;
  verification_token_hash: string | null;
  verification_sent_at: number | null;
  verification_expires_at: number | null;
  issued_at: number | null;
  rejected_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ApiKeyRequestAdminRow extends ApiKeyRequestRow {
  claim_status: "pending_verification" | "issued" | "released" | null;
  linked_key_prefix: string | null;
  linked_key_active: number | null;
  linked_key_expires_at: number | null;
}

const SELF_SERVE_BASE_URL = "https://api.pharos.watch" as const;
const SELF_SERVE_RETRY_GUIDANCE = "Respect Retry-After on 429 responses and add jitter to polling intervals.";
const ADMIN_STATUS_FILTERS = new Set<ApiKeySelfServeStatus>([
  "pending_verification",
  "issued",
  "rejected",
  "blocked",
  "expired",
]);

function selfServeError(status: number, message: string, retryAfterSec?: number): Response {
  return errorResponse(status, message, { noStore: true, retryAfterSec });
}

function selfServeUnavailable(): Response {
  return selfServeError(
    503,
    "API key self-serve is temporarily unavailable. Please try again.",
    SELF_SERVE_DEPENDENCY_RETRY_AFTER_SEC,
  );
}

export async function handleApiKeyRequest(
  db: D1Database,
  request: Request,
  env: ApiKeySelfServeEnv,
  execCtx?: ExecutionContext,
): Promise<Response> {
  try {
    const parsed = await parseSelfServeRequest(request);
    if (parsed instanceof Response) return parsed;
    if (parsed.website) {
      return jsonResponse({ ok: true }, { noStore: true });
    }

    const initialEnv = requireInitialSelfServeEnv(env);
    if (initialEnv instanceof Response) return initialEnv;

    const normalizedEmail = normalizeSelfServeEmail(parsed.email);
    if (normalizedEmail instanceof Response) return normalizedEmail;

    const intendedEndpoints = validateIntendedEndpoints(parsed.intendedEndpoints);
    if (intendedEndpoints instanceof Response) return intendedEndpoints;

    const nowSec = getNowSec();
    const emailHash = await hashForLookup(initialEnv.API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER, normalizedEmail);
    const ipHash = await hashClientIp(initialEnv.API_KEY_SELF_SERVE_IP_SALT, request);
    const userAgentHash = await hashUserAgent(initialEnv.API_KEY_SELF_SERVE_IP_SALT, request);

    const allowedByIp = await checkApiKeyRequestRateLimit(
      db,
      "ip",
      ipHash,
      3600,
      SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_IP_PER_HOUR,
      nowSec,
    );
    if (!allowedByIp) {
      return selfServeError(429, "Too many API key requests. Please wait before trying again.");
    }
    const allowedByEmail = await checkApiKeyRequestRateLimit(
      db,
      "email",
      emailHash,
      24 * 60 * 60,
      SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_EMAIL_PER_DAY,
      nowSec,
    );
    if (!allowedByEmail) {
      return selfServeError(429, "Too many API key requests for this email. Please wait before trying again.");
    }

    execCtx?.waitUntil(pruneOldApiKeyRequestRateLimits(db, nowSec - (2 * 24 * 60 * 60)));

    await releaseExpiredPendingClaim(db, emailHash, nowSec);
    await releaseInactiveIssuedClaim(db, emailHash, nowSec);

    const requestId = createRequestId();
    const token = createVerificationToken();
    const tokenHash = await hashForLookup(initialEnv.API_KEY_SELF_SERVE_REQUEST_PEPPER, token);
    const verificationExpiresAt = nowSec + SELF_SERVE_VERIFICATION_TOKEN_TTL_SEC;
    const selfServeExpiresAt = nowSec + SELF_SERVE_API_KEY_EXPIRY_SEC;

    const claimAcquired = await acquireEmailClaim(db, {
      emailHash,
      normalizedEmail,
      requestId,
      nowSec,
    });
    if (!claimAcquired) {
      return selfServeError(409, "An active or pending self-serve key already exists for this email.");
    }

    try {
      await insertPendingRequest(db, {
        parsed,
        requestId,
        normalizedEmail,
        emailHash,
        intendedEndpoints,
        ipHash,
        userAgentHash,
        tokenHash,
        verificationExpiresAt,
        selfServeExpiresAt,
        nowSec,
      });
    } catch (error) {
      console.error("[api-key-requests] failed to insert pending request:", error);
      await releaseEmailClaim(db, emailHash, requestId, nowSec).catch((releaseError) => {
        console.error("[api-key-requests] failed to release claim after pending insert failure:", releaseError);
      });
      return selfServeUnavailable();
    }

    const verificationUrl = buildVerificationUrl(initialEnv.API_KEY_SELF_SERVE_PUBLIC_BASE_URL, token);
    try {
      const sent = await sendVerificationEmail(initialEnv, {
        to: normalizedEmail,
        requestId,
        verificationUrl,
        expiresInMinutes: Math.floor(SELF_SERVE_VERIFICATION_TOKEN_TTL_SEC / 60),
      });
      if (sent.providerMessageId) {
        await db.prepare("UPDATE api_key_requests SET email_provider_message_id = ?, updated_at = ? WHERE request_id = ?")
          .bind(sent.providerMessageId, nowSec, requestId)
          .run();
      }
    } catch (error) {
      console.error("[api-key-requests] verification email send failed:", error);
      await markRequestExpired(db, requestId, nowSec).catch((markError) => {
        console.error("[api-key-requests] failed to mark request expired after email failure:", markError);
      });
      await releaseEmailClaim(db, emailHash, requestId, nowSec).catch((releaseError) => {
        console.error("[api-key-requests] failed to release claim after email failure:", releaseError);
      });
      return selfServeUnavailable();
    }

    return jsonResponse({
      status: "pending_verification",
      requestId,
      message: "Check your email to verify this request and reveal your API key.",
    }, { status: 202, noStore: true });
  } catch (error) {
    console.error("[api-key-requests] request handler failed:", error);
    return selfServeUnavailable();
  }
}

export async function handleApiKeyRequestVerify(
  db: D1Database,
  request: Request,
  env: ApiKeySelfServeEnv,
  apiKeyHashPepper: string | undefined,
  execCtx?: ExecutionContext,
): Promise<Response> {
  const effectiveApiKeyPepper = apiKeyHashPepper?.trim();
  if (!effectiveApiKeyPepper) {
    console.error("[api-key-requests] API_KEY_HASH_PEPPER missing for self-serve issuance");
    return selfServeUnavailable();
  }

  try {
    const parsed = await parseSelfServeVerifyRequest(request);
    if (parsed instanceof Response) return parsed;

    const verifyEnv = requireVerifySelfServeEnv(env);
    if (verifyEnv instanceof Response) return verifyEnv;

    const nowSec = getNowSec();
    const ipHash = await hashClientIp(verifyEnv.API_KEY_SELF_SERVE_IP_SALT, request);
    const tokenHash = await hashForLookup(verifyEnv.API_KEY_SELF_SERVE_REQUEST_PEPPER, parsed.token);

    const allowedByIp = await checkApiKeyRequestRateLimit(
      db,
      "ip",
      ipHash,
      10 * 60,
      SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_IP_10M,
      nowSec,
    );
    const allowedByToken = await checkApiKeyRequestRateLimit(
      db,
      "token",
      tokenHash,
      10 * 60,
      SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_TOKEN_10M,
      nowSec,
    );
    if (!allowedByIp || !allowedByToken) {
      return selfServeError(429, "Too many verification attempts. Please wait before trying again.");
    }
    execCtx?.waitUntil(pruneOldApiKeyRequestRateLimits(db, nowSec - (2 * 24 * 60 * 60)));

    const row = await selectPendingRequestByTokenHash(db, tokenHash);
    if (!row || row.status !== "pending_verification" || !row.verification_token_hash) {
      return selfServeError(400, "Invalid or expired verification token.");
    }
    if (row.verification_expires_at == null || row.verification_expires_at < nowSec) {
      await markRequestExpired(db, row.request_id, nowSec).catch((error) => {
        console.error("[api-key-requests] failed to expire stale verification:", error);
      });
      await releaseEmailClaim(db, row.email_hash, row.request_id, nowSec).catch((error) => {
        console.error("[api-key-requests] failed to release stale verification claim:", error);
      });
      return selfServeError(400, "Invalid or expired verification token.");
    }

    const previousIssuedCount = await countIssuedRequestsForIp(db, row.ip_hash, nowSec - (24 * 60 * 60));
    if (previousIssuedCount >= SELF_SERVE_MAX_CREATIONS_PER_IP_24H) {
      return selfServeError(429, "Too many issued self-serve keys from this network. Please wait before trying again.");
    }

    const consumed = await consumeVerificationToken(db, row.request_id, tokenHash, nowSec);
    if (!consumed) {
      return selfServeError(400, "Invalid or expired verification token.");
    }

    const created = await createTrustedApiKey(db, effectiveApiKeyPepper, {
      name: buildSelfServeKeyName(row),
      ownerEmail: row.normalized_email,
      tier: "self-serve",
      trafficClass: "external",
      rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
      expiresAt: nowSec + SELF_SERVE_API_KEY_EXPIRY_SEC,
    }, nowSec, null);
    if (created instanceof Response) {
      await markRequestBlockedAndReleaseClaim(db, row, nowSec);
      return selfServeUnavailable();
    }

    try {
      const requestUpdated = await markRequestIssued(db, row.request_id, created.key.id, created.key.expiresAt, nowSec);
      if (!requestUpdated) {
        throw new Error("self-serve request was not pending during issuance update");
      }
      const claimUpdated = await markClaimIssued(db, row.email_hash, row.request_id, created.key.id, nowSec);
      if (!claimUpdated) {
        throw new Error("self-serve email claim was not pending for this request");
      }
      await recordApiKeyAudit(db, created.key.id, "created", {
        requestId: row.request_id,
        normalizedEmail: row.normalized_email,
        intendedEndpoints: parseJsonStringArray(row.intended_endpoints_json),
        expectedCadence: row.expected_cadence,
        expectedVolume: row.expected_volume,
        selfServeDefaultQuota: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
        emailVerified: true,
        riskScore: row.risk_score,
        riskReasons: parseJsonStringArray(row.risk_reasons_json),
      }, nowSec, "self-serve");
    } catch (error) {
      console.error("[api-key-requests] issuance consistency write failed:", error);
      await compensateIssuedKeyFailure(db, created.key.id, created.key.keyPrefix, row, nowSec);
      return selfServeUnavailable();
    }

    const notification = notifySelfServeIssued(env.GITHUB_PAT, {
      requestId: row.request_id,
      keyPrefix: created.key.keyPrefix,
      expiresAt: created.key.expiresAt,
    });
    if (notification) {
      if (execCtx) {
        execCtx.waitUntil(notification);
      } else {
        void notification;
      }
    }

    const responseBody: ApiKeySelfServeIssueResponse = {
      status: "issued",
      requestId: row.request_id,
      key: {
        ...created.key,
        tier: "self-serve",
        trafficClass: "external",
        rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
      },
      token: created.token,
      usage: {
        baseUrl: SELF_SERVE_BASE_URL,
        headerName: "X-API-Key",
        retryGuidance: SELF_SERVE_RETRY_GUIDANCE,
      },
    };
    return jsonResponse(responseBody, { status: 201, noStore: true });
  } catch (error) {
    console.error("[api-key-requests] verify handler failed:", error);
    return selfServeUnavailable();
  }
}

export function handleApiKeyRequestsAdmin(
  db: D1Database,
  trustedAdmin: boolean,
  request: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-requests-admin",
      request,
      trustedAdmin,
    },
    async () => {
      const url = new URL(request.url);
      const status = parseOptionalEnumParam(url.searchParams.get("status"), ADMIN_STATUS_FILTERS, "status");
      if (status instanceof Response) return status;
      const parsedLimit = parseOptionalPositiveIntegerParam(url.searchParams.get("limit"), "limit", { max: 100 });
      if (parsedLimit instanceof Response) return parsedLimit;
      const rows = await listAdminRequests(db, status ?? null, parsedLimit ?? 50);
      const response: ApiKeySelfServeRequestAdminListResponse = {
        generatedAt: getNowSec(),
        requests: rows.map(mapAdminRow),
      };
      return adminJsonResponse(response);
    },
  );
}

export function handleApiKeyRequestReject(
  db: D1Database,
  requestId: string,
  trustedAdmin: boolean,
  request: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-request-reject",
      request,
      trustedAdmin,
    },
    async () => {
      const row = await selectRequestByRequestId(db, requestId);
      if (!row) return adminErrorResponse(404, "API key request not found");
      const nowSec = getNowSec();
      if (row.api_key_id != null) {
        await db.prepare("UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?")
          .bind(nowSec, row.api_key_id)
          .run();
        await recordApiKeyAudit(db, row.api_key_id, "deactivated", { requestId, reason: "self-serve request rejected" }, nowSec);
      }
      await db.prepare(
        "UPDATE api_key_requests SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE request_id = ?",
      )
        .bind(nowSec, nowSec, requestId)
        .run();
      await releaseEmailClaim(db, row.email_hash, requestId, nowSec);
      return adminJsonResponse(buildAdminMutationResponse(requestId, "rejected", "released"));
    },
  );
}

export function handleApiKeyRequestReleaseClaim(
  db: D1Database,
  requestId: string,
  trustedAdmin: boolean,
  request: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-request-release-claim",
      request,
      trustedAdmin,
    },
    async () => {
      const row = await selectRequestWithKeyStateByRequestId(db, requestId);
      if (!row) return adminErrorResponse(404, "API key request not found");
      const nowSec = getNowSec();
      if (row.linked_key_active === 1 && (row.linked_key_expires_at == null || row.linked_key_expires_at > nowSec)) {
        return adminErrorResponse(409, "Cannot release claim while the linked self-serve key is still active");
      }
      await releaseEmailClaim(db, row.email_hash, requestId, nowSec);
      if (row.status === "pending_verification") {
        await markRequestExpired(db, requestId, nowSec);
      }
      return adminJsonResponse(buildAdminMutationResponse(
        requestId,
        row.status === "pending_verification" ? "expired" : row.status,
        "released",
      ));
    },
  );
}

async function insertPendingRequest(
  db: ApiKeyRequestDb,
  input: {
    parsed: ParsedApiKeySelfServeRequest;
    requestId: string;
    normalizedEmail: string;
    emailHash: string;
    intendedEndpoints: string[];
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
       intended_endpoints_json,
       expected_cadence,
       expected_volume,
       accepted_terms,
       self_serve_rate_limit_per_minute,
       self_serve_expires_at,
       ip_hash,
       user_agent_hash,
       risk_score,
       risk_reasons_json,
       verification_token_hash,
       verification_sent_at,
       verification_expires_at,
       created_at,
       updated_at
     )
     VALUES (?, 'pending_verification', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.requestId,
      input.normalizedEmail,
      input.emailHash,
      normalizeOptionalText(input.parsed.requesterName),
      normalizeOptionalText(input.parsed.organization),
      normalizeOptionalText(input.parsed.projectUrl),
      input.parsed.useCase.trim(),
      JSON.stringify(input.intendedEndpoints),
      input.parsed.expectedCadence,
      normalizeOptionalText(input.parsed.expectedVolume),
      SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
      input.selfServeExpiresAt,
      input.ipHash,
      input.userAgentHash,
      JSON.stringify([]),
      input.tokenHash,
      input.nowSec,
      input.verificationExpiresAt,
      input.nowSec,
      input.nowSec,
    )
    .run();
}

async function acquireEmailClaim(
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

async function releaseExpiredPendingClaim(db: ApiKeyRequestDb, emailHash: string, nowSec: number): Promise<void> {
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

async function releaseInactiveIssuedClaim(db: ApiKeyRequestDb, emailHash: string, nowSec: number): Promise<void> {
  await db.prepare(
    `UPDATE api_key_self_serve_email_claims
     SET status = 'released', released_at = ?, updated_at = ?
     WHERE email_hash = ?
       AND status = 'issued'
       AND EXISTS (
         SELECT 1 FROM api_keys
         WHERE api_keys.id = api_key_self_serve_email_claims.api_key_id
           AND api_keys.is_active = 0
       )`,
  )
    .bind(nowSec, nowSec, emailHash)
    .run();
}

async function releaseEmailClaim(db: ApiKeyRequestDb, emailHash: string, requestId: string, nowSec: number): Promise<void> {
  await db.prepare(
    `UPDATE api_key_self_serve_email_claims
     SET status = 'released', released_at = ?, updated_at = ?
     WHERE email_hash = ? AND request_id = ?`,
  )
    .bind(nowSec, nowSec, emailHash, requestId)
    .run();
}

async function selectPendingRequestByTokenHash(db: ApiKeyRequestDb, tokenHash: string): Promise<ApiKeyRequestRow | null> {
  return db.prepare(
    `SELECT *
     FROM api_key_requests
     WHERE verification_token_hash = ?
     LIMIT 1`,
  )
    .bind(tokenHash)
    .first<ApiKeyRequestRow>();
}

async function selectRequestByRequestId(db: ApiKeyRequestDb, requestId: string): Promise<ApiKeyRequestRow | null> {
  return db.prepare("SELECT * FROM api_key_requests WHERE request_id = ?")
    .bind(requestId)
    .first<ApiKeyRequestRow>();
}

async function selectRequestWithKeyStateByRequestId(db: ApiKeyRequestDb, requestId: string): Promise<ApiKeyRequestAdminRow | null> {
  return db.prepare(
    `SELECT
       r.*,
       c.status AS claim_status,
       k.key_prefix AS linked_key_prefix,
       k.is_active AS linked_key_active,
       k.expires_at AS linked_key_expires_at
     FROM api_key_requests r
     LEFT JOIN api_key_self_serve_email_claims c ON c.request_id = r.request_id
     LEFT JOIN api_keys k ON k.id = r.api_key_id
     WHERE r.request_id = ?`,
  )
    .bind(requestId)
    .first<ApiKeyRequestAdminRow>();
}

async function consumeVerificationToken(
  db: ApiKeyRequestDb,
  requestId: string,
  tokenHash: string,
  nowSec: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE api_key_requests
     SET verification_token_hash = NULL,
       email_verified = 1,
       updated_at = ?
     WHERE request_id = ?
       AND status = 'pending_verification'
       AND verification_token_hash = ?
       AND verification_expires_at >= ?
       AND api_key_id IS NULL`,
  )
    .bind(nowSec, requestId, tokenHash, nowSec)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function countIssuedRequestsForIp(db: ApiKeyRequestDb, ipHash: string, afterSec: number): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM api_key_requests WHERE ip_hash = ? AND status = 'issued' AND issued_at > ?",
  )
    .bind(ipHash, afterSec)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function markRequestIssued(
  db: ApiKeyRequestDb,
  requestId: string,
  apiKeyId: number,
  expiresAt: number | null,
  nowSec: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE api_key_requests
     SET api_key_id = ?,
       status = 'issued',
       self_serve_expires_at = ?,
       issued_at = ?,
       updated_at = ?
     WHERE request_id = ? AND status = 'pending_verification'`,
  )
    .bind(apiKeyId, expiresAt, nowSec, nowSec, requestId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function markClaimIssued(
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

async function markRequestExpired(db: ApiKeyRequestDb, requestId: string, nowSec: number): Promise<void> {
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

async function markRequestBlockedAndReleaseClaim(
  db: ApiKeyRequestDb,
  row: ApiKeyRequestRow,
  nowSec: number,
): Promise<void> {
  await db.prepare(
    `UPDATE api_key_requests
     SET status = 'blocked',
       verification_token_hash = NULL,
       updated_at = ?
     WHERE request_id = ?`,
  )
    .bind(nowSec, row.request_id)
    .run();
  await releaseEmailClaim(db, row.email_hash, row.request_id, nowSec);
}

async function compensateIssuedKeyFailure(
  db: ApiKeyRequestDb,
  apiKeyId: number,
  keyPrefix: string,
  row: ApiKeyRequestRow,
  nowSec: number,
): Promise<void> {
  try {
    await db.prepare("UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?")
      .bind(nowSec, apiKeyId)
      .run();
    clearApiKeyCache(keyPrefix);
  } catch (error) {
    console.error("[api-key-requests] failed to deactivate key during compensation:", error);
  }
  try {
    await markRequestBlockedAndReleaseClaim(db, row, nowSec);
  } catch (error) {
    console.error("[api-key-requests] failed to mark request blocked during compensation:", error);
  }
}

async function listAdminRequests(
  db: ApiKeyRequestDb,
  status: ApiKeySelfServeStatus | null,
  limit: number,
): Promise<ApiKeyRequestAdminRow[]> {
  const where = status ? "WHERE r.status = ?" : "";
  const statement = db.prepare(
    `SELECT
       r.*,
       c.status AS claim_status,
       k.key_prefix AS linked_key_prefix,
       k.is_active AS linked_key_active,
       k.expires_at AS linked_key_expires_at
     FROM api_key_requests r
     LEFT JOIN api_key_self_serve_email_claims c ON c.request_id = r.request_id
     LEFT JOIN api_keys k ON k.id = r.api_key_id
     ${where}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`,
  );
  const result = status
    ? await statement.bind(status, limit).all<ApiKeyRequestAdminRow>()
    : await statement.bind(limit).all<ApiKeyRequestAdminRow>();
  return result.results ?? [];
}

function mapAdminRow(row: ApiKeyRequestAdminRow): ApiKeySelfServeRequestAdminSummary {
  return {
    requestId: row.request_id,
    status: row.status,
    email: row.normalized_email,
    requesterName: row.requester_name,
    organization: row.organization,
    projectUrl: row.project_url,
    useCase: row.use_case,
    intendedEndpoints: parseJsonStringArray(row.intended_endpoints_json),
    expectedCadence: row.expected_cadence,
    expectedVolume: row.expected_volume,
    acceptedTerms: row.accepted_terms === 1,
    emailVerified: row.email_verified === 1,
    linkedKeyId: row.api_key_id,
    linkedKeyPrefix: row.linked_key_prefix,
    linkedKeyActive: row.linked_key_active == null ? null : row.linked_key_active === 1,
    linkedKeyExpiresAt: row.linked_key_expires_at,
    rateLimitPerMinute: row.self_serve_rate_limit_per_minute,
    selfServeExpiresAt: row.self_serve_expires_at,
    riskScore: row.risk_score,
    riskReasons: parseJsonStringArray(row.risk_reasons_json),
    claimStatus: row.claim_status,
    verificationSentAt: row.verification_sent_at,
    verificationExpiresAt: row.verification_expires_at,
    issuedAt: row.issued_at,
    rejectedAt: row.rejected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function buildSelfServeKeyName(row: ApiKeyRequestRow): string {
  const owner = row.organization || row.requester_name || row.normalized_email;
  return `Self-serve: ${owner}`.slice(0, 80);
}

function buildAdminMutationResponse(
  requestId: string,
  status: ApiKeySelfServeStatus,
  claimStatus: "pending_verification" | "issued" | "released" | null,
): ApiKeySelfServeAdminMutationResponse {
  return {
    ok: true,
    requestId,
    status,
    claimStatus,
  };
}

function notifySelfServeIssued(
  pat: string | undefined,
  input: { requestId: string; keyPrefix: string; expiresAt: number | null },
): Promise<void> | null {
  if (!pat) return null;
  const body = [
    "A self-serve API key was issued.",
    "",
    `- Request ID: ${input.requestId}`,
    `- Key prefix: ${input.keyPrefix}`,
    `- Quota: ${SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE} rpm`,
    `- Expires at: ${input.expiresAt ?? "never"}`,
    "- Details: https://ops.pharos.watch/admin-api/",
    "",
    "Private requester details are available only in the Access-gated admin UI.",
  ].join("\n");
  return createGitHubIssue(
    pat,
    `Self-serve API key issued: ${input.requestId}`,
    body,
    ["api-key-request", "self-serve-issued"],
  ).catch((error) => {
    console.warn("[api-key-requests] best-effort notification failed:", error);
  });
}
