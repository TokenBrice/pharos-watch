import type {
  ApiKeySelfServeRequestAdminListResponse,
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
import { activateTrustedApiKey, createTrustedApiKey } from "../lib/api-key-admin";
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
import {
  buildAdminMutationResponse,
  deactivateLinkedSelfServeKey,
  listAdminRequests,
  mapAdminRow,
  parseAdminMutationBody,
  recordRequestAdminAction,
  recordSelfServeRevocation,
  selectRequestWithKeyStateByRequestId,
} from "./api-key-requests/admin";
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
import {
  buildSelfServeKeyName,
  issuedPublicResponse,
  pendingPublicResponse,
} from "./api-key-requests/responses";
import { parseJsonStringArray } from "./api-key-requests/serialization";
import type {
  ApiKeyRequestDb,
  ApiKeyRequestRow,
  ApiKeySelfServeEnv,
  ParsedApiKeySelfServeRequest,
} from "./api-key-requests/types";

const ORPHAN_CLAIM_GRACE_SEC = 10 * 60;
const ISSUANCE_LOCK_STALE_SEC = 10 * 60;
const ISSUANCE_IP_CAP_WINDOW_SEC = 24 * 60 * 60;
const ISSUANCE_IP_CAP_SCOPE = "submission_ip_daily" as const;
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
      "submission_ip",
      ipHash,
      3600,
      SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_IP_PER_HOUR,
      nowSec,
    );
    if (!allowedByIp.allowed) {
      return selfServeError(429, "Too many API key requests. Please wait before trying again.", allowedByIp.retryAfterSec);
    }

    execCtx?.waitUntil(pruneOldApiKeyRequestRateLimits(db, nowSec - (2 * 24 * 60 * 60)));
    await releaseOrphanPendingClaims(db, nowSec).catch((error) => {
      console.error("[api-key-requests] orphan claim cleanup failed:", error);
    });

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
      return pendingPublicResponse();
    }

    const allowedByEmail = await checkApiKeyRequestRateLimit(
      db,
      "submission_email",
      emailHash,
      24 * 60 * 60,
      SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_EMAIL_PER_DAY,
      nowSec,
    );
    if (!allowedByEmail.allowed) {
      await releaseEmailClaim(db, emailHash, requestId, nowSec).catch((releaseError) => {
        console.error("[api-key-requests] failed to release claim after email rate limit:", releaseError);
      });
      return selfServeError(429, "Too many API key requests. Please wait before trying again.", allowedByEmail.retryAfterSec);
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
        await db.prepare(
          "UPDATE api_key_requests SET email_provider_message_id = ?, verification_sent_at = ?, updated_at = ? WHERE request_id = ?",
        )
          .bind(sent.providerMessageId, nowSec, nowSec, requestId)
          .run()
          .catch((error) => {
            console.error("[api-key-requests] failed to persist email provider metadata:", error);
          });
      } else {
        await db.prepare("UPDATE api_key_requests SET verification_sent_at = ?, updated_at = ? WHERE request_id = ?")
          .bind(nowSec, nowSec, requestId)
          .run()
          .catch((error) => {
            console.error("[api-key-requests] failed to persist verification sent timestamp:", error);
          });
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

    return pendingPublicResponse();
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
      "verification_ip",
      ipHash,
      10 * 60,
      SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_IP_10M,
      nowSec,
    );
    const allowedByToken = await checkApiKeyRequestRateLimit(
      db,
      "verification_token",
      tokenHash,
      10 * 60,
      SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_TOKEN_10M,
      nowSec,
    );
    if (!allowedByIp.allowed || !allowedByToken.allowed) {
      return selfServeError(
        429,
        "Too many verification attempts. Please wait before trying again.",
        Math.max(allowedByIp.retryAfterSec, allowedByToken.retryAfterSec),
      );
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

    const activeClaim = await selectCurrentPendingClaim(db, row.email_hash, row.request_id);
    if (!activeClaim) {
      await markRequestBlockedAndReleaseClaim(db, row, nowSec).catch((error) => {
        console.error("[api-key-requests] failed to block request with missing pending claim:", error);
      });
      return selfServeError(400, "Invalid or expired verification token.");
    }

    const issuanceIpCap = await acquireIssuanceIpCap(db, row.ip_hash, nowSec);
    if (!issuanceIpCap.allowed) {
      return selfServeError(
        429,
        "Too many issued self-serve keys from this network. Please wait before trying again.",
        issuanceIpCap.retryAfterSec,
      );
    }

    const locked = await lockVerificationForIssuance(db, row.request_id, tokenHash, nowSec);
    if (!locked) {
      await releaseIssuanceIpCap(db, row.ip_hash, nowSec).catch((error) => {
        console.error("[api-key-requests] failed to release issuance IP cap after lock denial:", error);
      });
      return selfServeError(400, "Invalid or expired verification token.");
    }

    const created = await createTrustedApiKey(db, effectiveApiKeyPepper, {
      name: buildSelfServeKeyName(row),
      ownerEmail: row.normalized_email,
      tier: "self-serve",
      trafficClass: "external",
      rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
      expiresAt: nowSec + SELF_SERVE_API_KEY_EXPIRY_SEC,
      isActive: false,
    }, nowSec, null);
    if (created instanceof Response) {
      await releaseIssuanceIpCap(db, row.ip_hash, nowSec).catch((error) => {
        console.error("[api-key-requests] failed to release issuance IP cap after key-create failure:", error);
      });
      await releaseVerificationLock(db, row.request_id, nowSec).catch((error) => {
        console.error("[api-key-requests] failed to release issuance lock after key-create failure:", error);
      });
      return selfServeUnavailable();
    }

    let issuedKey = created.key;
    try {
      const requestLinked = await linkRequestForIssuance(
        db,
        row.request_id,
        tokenHash,
        created.key.id,
        created.key.expiresAt,
        nowSec,
      );
      if (!requestLinked) {
        throw new Error("self-serve request was not pending during issuance link");
      }
      const claimUpdated = await markClaimIssued(db, row.email_hash, row.request_id, created.key.id, nowSec);
      if (!claimUpdated) {
        throw new Error("self-serve email claim was not pending for this request");
      }
      await recordApiKeyAudit(db, created.key.id, "created", {
        requestId: row.request_id,
        intendedEndpoints: parseJsonStringArray(row.intended_endpoints_json),
        expectedCadence: row.expected_cadence,
        expectedVolume: row.expected_volume,
        selfServeDefaultQuota: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
        emailVerified: true,
        riskScore: row.risk_score,
        riskReasons: parseJsonStringArray(row.risk_reasons_json),
      }, nowSec, "self-serve");
      const activated = await activateTrustedApiKey(db, created.key.id, created.key.keyPrefix, nowSec);
      if (activated instanceof Response) {
        throw new Error("self-serve API key activation failed");
      }
      issuedKey = activated.key;
      const requestIssued = await finalizeRequestIssued(db, row.request_id, tokenHash, created.key.id, nowSec);
      if (!requestIssued) {
        throw new Error("self-serve request was not pending during issuance finalize");
      }
    } catch (error) {
      console.error("[api-key-requests] issuance consistency write failed:", error);
      await releaseIssuanceIpCap(db, row.ip_hash, nowSec).catch((releaseError) => {
        console.error("[api-key-requests] failed to release issuance IP cap after consistency failure:", releaseError);
      });
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

    return issuedPublicResponse(issuedKey, created.token);
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
      db,
      action: "api-key-request-reject",
    },
    async () => {
      const parsedBody = await parseAdminMutationBody(request);
      if (parsedBody instanceof Response) return parsedBody;
      const row = await selectRequestWithKeyStateByRequestId(db, requestId);
      if (!row) return adminErrorResponse(404, "API key request not found");
      const nowSec = getNowSec();
      if (row.status === "rejected") {
        return adminJsonResponse(buildAdminMutationResponse(requestId, "rejected", "released"));
      }
      if (row.status !== "pending_verification" && row.status !== "issued") {
        return adminErrorResponse(409, "Only pending or issued self-serve requests can be rejected");
      }
      if (row.api_key_id != null) {
        const linkedKeyPrefix = row.linked_key_prefix;
        const mismatch = row.linked_key_tier !== "self-serve"
          || row.linked_key_owner_email !== row.normalized_email
          || !linkedKeyPrefix;
        if (mismatch) {
          return adminErrorResponse(409, "Linked API key does not match the self-serve request");
        }
        await recordSelfServeRevocation(db, {
          apiKeyId: row.api_key_id,
          keyPrefix: linkedKeyPrefix,
          requestId,
          nowSec,
          reason: "admin_reject",
        });
        await deactivateLinkedSelfServeKey(db, {
          apiKeyId: row.api_key_id,
          keyPrefix: linkedKeyPrefix,
          requestId,
          nowSec,
        });
      }
      const updated = await db.prepare(
        "UPDATE api_key_requests SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE request_id = ? AND status IN ('pending_verification', 'issued')",
      )
        .bind(nowSec, nowSec, requestId)
        .run();
      if ((updated.meta?.changes ?? 0) === 0) {
        return adminErrorResponse(409, "API key request state changed before rejection");
      }
      await releaseEmailClaim(db, row.email_hash, requestId, nowSec);
      await recordRequestAdminAction(db, {
        action: "api_key_request_reject",
        requestId,
        status: 200,
        resultStatus: "rejected",
        claimStatus: "released",
        reason: parsedBody.reason,
        nowSec,
      });
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
      db,
      action: "api-key-request-release-claim",
    },
    async () => {
      const parsedBody = await parseAdminMutationBody(request);
      if (parsedBody instanceof Response) return parsedBody;
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
      const resultStatus = row.status === "pending_verification" ? "expired" : row.status;
      await recordRequestAdminAction(db, {
        action: "api_key_request_release_claim",
        requestId,
        status: 200,
        resultStatus,
        claimStatus: "released",
        reason: parsedBody.reason,
        nowSec,
      });
      return adminJsonResponse(buildAdminMutationResponse(
        requestId,
        resultStatus,
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
     VALUES (?, 'pending_verification', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)`,
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

async function releaseOrphanPendingClaims(db: ApiKeyRequestDb, nowSec: number): Promise<void> {
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
    console.warn(`[api-key-requests] released ${released} orphan pending self-serve email claim(s)`);
  }
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
           AND (
             api_keys.is_active = 0
             OR (api_keys.expires_at IS NOT NULL AND api_keys.expires_at <= ?)
           )
       )`,
  )
    .bind(nowSec, nowSec, emailHash, nowSec)
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

async function selectCurrentPendingClaim(
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

async function lockVerificationForIssuance(
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

async function releaseVerificationLock(db: ApiKeyRequestDb, requestId: string, nowSec: number): Promise<void> {
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

async function acquireIssuanceIpCap(
  db: ApiKeyRequestDb,
  ipHash: string,
  nowSec: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const bucketStart = Math.floor(nowSec / ISSUANCE_IP_CAP_WINDOW_SEC) * ISSUANCE_IP_CAP_WINDOW_SEC;
  const result = await db.prepare(
    `INSERT INTO api_key_self_serve_issuance_limits (
       scope,
       subject_hash,
       bucket_start,
       count,
       updated_at
     )
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, subject_hash, bucket_start) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at
     WHERE api_key_self_serve_issuance_limits.count < ?`,
  )
    .bind(ISSUANCE_IP_CAP_SCOPE, ipHash, bucketStart, nowSec, SELF_SERVE_MAX_CREATIONS_PER_IP_24H)
    .run();
  return {
    allowed: (result.meta?.changes ?? 0) > 0,
    retryAfterSec: Math.max(1, bucketStart + ISSUANCE_IP_CAP_WINDOW_SEC - nowSec),
  };
}

async function releaseIssuanceIpCap(db: ApiKeyRequestDb, ipHash: string, nowSec: number): Promise<void> {
  const bucketStart = Math.floor(nowSec / ISSUANCE_IP_CAP_WINDOW_SEC) * ISSUANCE_IP_CAP_WINDOW_SEC;
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

async function linkRequestForIssuance(
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

async function finalizeRequestIssued(
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
