import type {
  ApiKeySelfServeAdminMutationResponse,
  ApiKeySelfServeClaimStatus,
  ApiKeySelfServeRequestAdminSummary,
  ApiKeySelfServeStatus,
} from "@shared/types";
import {
  clearApiKeyCache,
  getApiKeyRuntimeState,
  recordApiKeyAudit,
} from "../../lib/api-key-core";
import { parseOptionalRequestJsonObject } from "../../lib/api-json-body";
import type {
  ApiKeyRequestAdminRow,
  ApiKeyRequestDb,
} from "./types";
import { logWorkerEvent } from "../../lib/structured-log";

export async function parseAdminMutationBody(request: Request): Promise<{ reason: string | null } | Response> {
  const body = await parseOptionalRequestJsonObject(request);
  if (body instanceof Response) return body;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  return { reason: reason ? reason.slice(0, 500) : null };
}

const ADMIN_REQUEST_WITH_KEY_STATE_SELECT = `SELECT
       r.*,
       c.status AS claim_status,
       k.owner_email AS linked_key_owner_email,
       k.key_prefix AS linked_key_prefix,
       k.tier AS linked_key_tier,
       k.is_active AS linked_key_active,
       k.expires_at AS linked_key_expires_at
     FROM api_key_requests r
     LEFT JOIN api_key_self_serve_email_claims c ON c.request_id = r.request_id
     LEFT JOIN api_keys k ON k.id = r.api_key_id`;

export async function selectRequestWithKeyStateByRequestId(
  db: ApiKeyRequestDb,
  requestId: string,
): Promise<ApiKeyRequestAdminRow | null> {
  return db.prepare(
    `${ADMIN_REQUEST_WITH_KEY_STATE_SELECT}
     WHERE r.request_id = ?`,
  )
    .bind(requestId)
    .first<ApiKeyRequestAdminRow>();
}

export async function listAdminRequests(
  db: ApiKeyRequestDb,
  status: ApiKeySelfServeStatus | null,
  limit: number,
): Promise<ApiKeyRequestAdminRow[]> {
  const where = status ? "WHERE r.status = ?" : "";
  const statement = db.prepare(
    `${ADMIN_REQUEST_WITH_KEY_STATE_SELECT}
     ${where}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`,
  );
  const result = status
    ? await statement.bind(status, limit).all<ApiKeyRequestAdminRow>()
    : await statement.bind(limit).all<ApiKeyRequestAdminRow>();
  return result.results ?? [];
}

export function mapAdminRow(row: ApiKeyRequestAdminRow): ApiKeySelfServeRequestAdminSummary {
  return {
    requestId: row.request_id,
    status: row.status,
    email: row.normalized_email,
    requesterName: row.requester_name,
    organization: row.organization,
    projectUrl: row.project_url,
    useCase: row.use_case,
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
    claimStatus: row.claim_status,
    verificationSentAt: row.verification_sent_at,
    verificationExpiresAt: row.verification_expires_at,
    issuedAt: row.issued_at,
    rejectedAt: row.rejected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function buildAdminMutationResponse(
  requestId: string,
  status: ApiKeySelfServeStatus,
  claimStatus: ApiKeySelfServeClaimStatus | null,
): ApiKeySelfServeAdminMutationResponse {
  return {
    ok: true,
    requestId,
    status,
    claimStatus,
  };
}

export async function recordSelfServeRevocation(
  db: ApiKeyRequestDb,
  input: {
    apiKeyId: number;
    keyPrefix: string;
    requestId: string;
    nowSec: number;
    reason: string;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO api_key_self_serve_revocations (
       key_prefix,
       api_key_id,
       request_id,
       reason,
       revoked_at
     )
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key_prefix) DO UPDATE SET
       api_key_id = excluded.api_key_id,
       request_id = excluded.request_id,
       reason = excluded.reason,
       revoked_at = excluded.revoked_at`,
  )
    .bind(input.keyPrefix, input.apiKeyId, input.requestId, input.reason, input.nowSec)
    .run();
}

export async function deactivateLinkedSelfServeKey(
  db: ApiKeyRequestDb,
  input: {
    apiKeyId: number;
    keyPrefix: string;
    requestId: string;
    nowSec: number;
  },
): Promise<void> {
  await db.prepare(
    "UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ? AND tier = 'self-serve'",
  )
    .bind(input.nowSec, input.apiKeyId)
    .run();
  clearApiKeyCache(input.keyPrefix);
  getApiKeyRuntimeState().apiKeyLastUsageUpdateById.delete(input.apiKeyId);
  await recordApiKeyAudit(
    db,
    input.apiKeyId,
    "deactivated",
    { requestId: input.requestId, reason: "self-serve request rejected" },
    input.nowSec,
  );
}

export async function recordRequestAdminAction(
  db: ApiKeyRequestDb,
  input: {
    action: string;
    requestId: string;
    status: number;
    resultStatus: ApiKeySelfServeStatus;
    claimStatus: ApiKeySelfServeClaimStatus | null;
    reason: string | null;
    nowSec: number;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO admin_action_audit (
       created_at,
       actor,
       action,
       target,
       result,
       http_status,
       details_json
     )
     VALUES (?, 'admin', ?, ?, 'ok', ?, ?)`,
  )
    .bind(
      input.nowSec,
      input.action,
      input.requestId,
      input.status,
      JSON.stringify({
        requestId: input.requestId,
        status: input.resultStatus,
        claimStatus: input.claimStatus,
        reason: input.reason,
      }),
    )
    .run()
    .catch((error) => {
      logWorkerEvent({
        scope: "admin",
        level: "error",
        event: "api_key_request_admin_audit_write_failed",
        route: "api-key-requests-admin",
        source: "admin_action_audit",
        message: "Failed to record API key request admin action",
        error,
        metadata: {
          action: input.action,
          resultStatus: input.resultStatus,
          claimStatus: input.claimStatus,
        },
      });
    });
}
