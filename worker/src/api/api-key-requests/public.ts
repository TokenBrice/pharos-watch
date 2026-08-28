import {
  SELF_SERVE_API_KEY_EXPIRY_SEC,
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_EMAIL_PER_DAY,
  SELF_SERVE_SUBMISSION_RATE_LIMIT_PER_IP_PER_HOUR,
  SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_IP_10M,
  SELF_SERVE_VERIFICATION_ATTEMPT_LIMIT_PER_TOKEN_10M,
  SELF_SERVE_VERIFICATION_TOKEN_TTL_SEC,
} from "@shared/lib/ops-limits";
import { activateTrustedApiKey, createTrustedApiKey } from "../../lib/api-key-admin";
import { getNowSec, recordApiKeyAudit } from "../../lib/api-key-core";
import { jsonResponse } from "../../lib/api-response";
import { logWorkerEvent } from "../../lib/structured-log";
import { sendVerificationEmail } from "./email";
import { checkApiKeyRequestRateLimit, pruneOldApiKeyRequestRateLimits } from "./rate-limit";
import {
  buildVerificationUrl,
  createRequestId,
  createVerificationToken,
  hashClientIp,
  hashForLookup,
  hashUserAgent,
  normalizeSelfServeEmail,
  parseSelfServeRequest,
  parseSelfServeVerifyRequest,
  requireInitialSelfServeEnv,
  requireVerifySelfServeEnv,
} from "./request";
import {
  buildSelfServeKeyName,
  issuedPublicResponse,
  pendingPublicResponse,
  selfServeError,
  selfServeUnavailable,
} from "./responses";
import {
  acquireEmailClaim,
  acquireIssuanceIpCap,
  compensateIssuedKeyFailure,
  finalizeRequestIssued,
  insertPendingRequest,
  linkRequestForIssuance,
  lockVerificationForIssuance,
  markClaimIssued,
  markRequestBlockedAndReleaseClaim,
  markRequestExpired,
  releaseEmailClaim,
  releaseExpiredPendingClaim,
  releaseInactiveIssuedClaim,
  releaseIssuanceIpCap,
  releaseOrphanPendingClaims,
  releaseVerificationLock,
  selectCurrentPendingClaim,
  selectPendingRequestByTokenHash,
} from "./state";
import type { ApiKeySelfServeEnv } from "./types";

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
      return selfServeError(
        429,
        "Too many API key requests. Please wait before trying again.",
        allowedByIp.retryAfterSec,
      );
    }

    execCtx?.waitUntil(pruneOldApiKeyRequestRateLimits(db, nowSec - 2 * 24 * 60 * 60));
    execCtx?.waitUntil(
      releaseOrphanPendingClaims(db, nowSec).catch((error) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_orphan_claim_cleanup_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_email_claims",
          message: "Orphan claim cleanup failed",
          error,
        });
      }),
    );

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
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_claim_release_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_email_claims",
          message: "Failed to release claim after email rate limit",
          error: releaseError,
          metadata: { requestId, stage: "email_rate_limit" },
        });
      });
      return selfServeError(
        429,
        "Too many API key requests. Please wait before trying again.",
        allowedByEmail.retryAfterSec,
      );
    }

    try {
      await insertPendingRequest(db, {
        parsed,
        requestId,
        normalizedEmail,
        emailHash,
        ipHash,
        userAgentHash,
        tokenHash,
        verificationExpiresAt,
        selfServeExpiresAt,
        nowSec,
      });
    } catch (error) {
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "api_key_request_pending_insert_failed",
        route: "api-key-requests",
        source: "api_key_requests",
        message: "Failed to insert pending request",
        error,
        metadata: { requestId },
      });
      await releaseEmailClaim(db, emailHash, requestId, nowSec).catch((releaseError) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_claim_release_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_email_claims",
          message: "Failed to release claim after pending insert failure",
          error: releaseError,
          metadata: { requestId, stage: "pending_insert_failure" },
        });
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
        await db
          .prepare(
            "UPDATE api_key_requests SET email_provider_message_id = ?, verification_sent_at = ?, updated_at = ? WHERE request_id = ?",
          )
          .bind(sent.providerMessageId, nowSec, nowSec, requestId)
          .run()
          .catch((error) => {
            logWorkerEvent({
              scope: "api",
              level: "error",
              event: "api_key_request_email_metadata_persist_failed",
              route: "api-key-requests",
              source: "api_key_requests",
              message: "Failed to persist email provider metadata",
              error,
              metadata: { requestId },
            });
          });
      } else {
        await db
          .prepare("UPDATE api_key_requests SET verification_sent_at = ?, updated_at = ? WHERE request_id = ?")
          .bind(nowSec, nowSec, requestId)
          .run()
          .catch((error) => {
            logWorkerEvent({
              scope: "api",
              level: "error",
              event: "api_key_request_verification_timestamp_persist_failed",
              route: "api-key-requests",
              source: "api_key_requests",
              message: "Failed to persist verification sent timestamp",
              error,
              metadata: { requestId },
            });
          });
      }
    } catch (error) {
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "api_key_request_verification_email_send_failed",
        route: "api-key-requests",
        source: "email",
        message: "Verification email send failed",
        error,
        metadata: { requestId },
      });
      await markRequestExpired(db, requestId, nowSec).catch((markError) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_mark_expired_failed",
          route: "api-key-requests",
          source: "api_key_requests",
          message: "Failed to mark request expired after email failure",
          error: markError,
          metadata: { requestId, stage: "email_failure" },
        });
      });
      await releaseEmailClaim(db, emailHash, requestId, nowSec).catch((releaseError) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_claim_release_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_email_claims",
          message: "Failed to release claim after email failure",
          error: releaseError,
          metadata: { requestId, stage: "email_failure" },
        });
      });
      return selfServeUnavailable();
    }

    return pendingPublicResponse();
  } catch (error) {
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "api_key_request_handler_failed",
      route: "api-key-requests",
      source: "handler",
      message: "API key request handler failed",
      error,
    });
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
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "api_key_request_pepper_missing",
      route: "api-key-requests",
      source: "config",
      message: "API_KEY_HASH_PEPPER missing for self-serve issuance",
    });
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
    execCtx?.waitUntil(pruneOldApiKeyRequestRateLimits(db, nowSec - 2 * 24 * 60 * 60));

    const row = await selectPendingRequestByTokenHash(db, tokenHash);
    if (!row || row.status !== "pending_verification" || !row.verification_token_hash) {
      return selfServeError(400, "Invalid or expired verification token.");
    }
    if (row.verification_expires_at == null || row.verification_expires_at < nowSec) {
      await markRequestExpired(db, row.request_id, nowSec).catch((error) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_mark_expired_failed",
          route: "api-key-requests",
          source: "api_key_requests",
          message: "Failed to expire stale verification",
          error,
          metadata: { requestId: row.request_id, stage: "stale_verification" },
        });
      });
      await releaseEmailClaim(db, row.email_hash, row.request_id, nowSec).catch((error) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_claim_release_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_email_claims",
          message: "Failed to release stale verification claim",
          error,
          metadata: { requestId: row.request_id, stage: "stale_verification" },
        });
      });
      return selfServeError(400, "Invalid or expired verification token.");
    }

    const activeClaim = await selectCurrentPendingClaim(db, row.email_hash, row.request_id);
    if (!activeClaim) {
      await markRequestBlockedAndReleaseClaim(db, row, nowSec).catch((error) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_block_failed",
          route: "api-key-requests",
          source: "api_key_requests",
          message: "Failed to block request with missing pending claim",
          error,
          metadata: { requestId: row.request_id, stage: "missing_pending_claim" },
        });
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
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_ip_cap_release_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_issuance_ip_cap",
          message: "Failed to release issuance IP cap after lock denial",
          error,
          metadata: { requestId: row.request_id, stage: "lock_denial" },
        });
      });
      return selfServeError(400, "Invalid or expired verification token.");
    }

    const created = await createTrustedApiKey(
      db,
      effectiveApiKeyPepper,
      {
        name: buildSelfServeKeyName(row),
        ownerEmail: row.normalized_email,
        tier: "self-serve",
        rateLimitPerMinute: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
        expiresAt: nowSec + SELF_SERVE_API_KEY_EXPIRY_SEC,
        isActive: false,
      },
      nowSec,
      null,
    );
    if (created instanceof Response) {
      await releaseIssuanceIpCap(db, row.ip_hash, nowSec).catch((error) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_ip_cap_release_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_issuance_ip_cap",
          message: "Failed to release issuance IP cap after key-create failure",
          error,
          metadata: { requestId: row.request_id, stage: "key_create_failure" },
        });
      });
      await releaseVerificationLock(db, row.request_id, nowSec).catch((error) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_verification_lock_release_failed",
          route: "api-key-requests",
          source: "api_key_requests",
          message: "Failed to release issuance lock after key-create failure",
          error,
          metadata: { requestId: row.request_id, stage: "key_create_failure" },
        });
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
      await recordApiKeyAudit(
        db,
        created.key.id,
        "created",
        {
          requestId: row.request_id,
          expectedCadence: row.expected_cadence,
          expectedVolume: row.expected_volume,
          selfServeDefaultQuota: SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
          emailVerified: true,
        },
        nowSec,
        "self-serve",
      );
      const requestIssued = await finalizeRequestIssued(db, row.request_id, tokenHash, created.key.id, nowSec);
      if (!requestIssued) {
        throw new Error("self-serve request was not pending during issuance finalize");
      }
      const activated = await activateTrustedApiKey(db, created.key.id, created.key.keyPrefix, nowSec);
      if (activated instanceof Response) {
        throw new Error("self-serve API key activation failed");
      }
      issuedKey = activated.key;
    } catch (error) {
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "api_key_request_issuance_consistency_failed",
        route: "api-key-requests",
        source: "issuance",
        message: "Issuance consistency write failed",
        error,
        metadata: { requestId: row.request_id, apiKeyId: created.key.id },
      });
      await releaseIssuanceIpCap(db, row.ip_hash, nowSec).catch((releaseError) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_ip_cap_release_failed",
          route: "api-key-requests",
          source: "api_key_self_serve_issuance_ip_cap",
          message: "Failed to release issuance IP cap after consistency failure",
          error: releaseError,
          metadata: { requestId: row.request_id, stage: "consistency_failure" },
        });
      });
      const compensation = await compensateIssuedKeyFailure(db, created.key.id, created.key.keyPrefix, row, nowSec);
      if (!compensation.keyDeactivated || !compensation.requestBlocked) {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "api_key_request_compensation_incomplete",
          route: "api-key-requests",
          source: "issuance",
          message: "Issuance compensation incomplete",
          metadata: {
            failureClass: "self_serve_issuance_compensation_incomplete",
            requestId: row.request_id,
            apiKeyId: created.key.id,
            keyDeactivated: compensation.keyDeactivated,
            requestBlocked: compensation.requestBlocked,
          },
        });
      }
      return selfServeUnavailable();
    }

    return issuedPublicResponse(issuedKey, created.token);
  } catch (error) {
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "api_key_request_verify_handler_failed",
      route: "api-key-requests",
      source: "handler",
      message: "API key request verify handler failed",
      error,
    });
    return selfServeUnavailable();
  }
}
