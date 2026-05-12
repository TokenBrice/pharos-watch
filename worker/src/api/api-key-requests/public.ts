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
import {
  getNowSec,
  recordApiKeyAudit,
} from "../../lib/api-key-core";
import { jsonResponse } from "../../lib/api-utils";
import { sendVerificationEmail } from "./email";
import { notifySelfServeIssued } from "./notifications";
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
  validateIntendedEndpoints,
} from "./request";
import {
  buildSelfServeKeyName,
  issuedPublicResponse,
  pendingPublicResponse,
  selfServeError,
  selfServeUnavailable,
} from "./responses";
import { parseJsonStringArray } from "./serialization";
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
