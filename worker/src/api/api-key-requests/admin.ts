import { z } from "zod";
import {
  ApiKeySelfServeClaimStatusSchema,
  ApiKeySelfServeStatusSchema,
  type ApiKeySelfServeAdminMutationResponse,
  type ApiKeySelfServeClaimStatus,
  type ApiKeySelfServeRequestAdminSummary,
  type ApiKeySelfServeStatus,
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

/**
 * Narrow decoder for the admin join. The browser parses the whole list response
 * strictly, so one malformed row is quarantined here (rule R8) instead of
 * publishing a payload the panel cannot read.
 */
const ApiKeyRequestAdminRowSchema = z
  .object({
    id: z.number(),
    request_id: z.string().min(1),
    api_key_id: z.number().nullable(),
    status: ApiKeySelfServeStatusSchema,
    normalized_email: z.string(),
    email_hash: z.string(),
    email_verified: z.number(),
    requester_name: z.string().nullable(),
    organization: z.string().nullable(),
    project_url: z.string().nullable(),
    use_case: z.string(),
    expected_cadence: z.string().nullable(),
    expected_volume: z.string().nullable(),
    accepted_terms: z.number(),
    self_serve_rate_limit_per_minute: z.number(),
    self_serve_expires_at: z.number().nullable(),
    ip_hash: z.string(),
    user_agent_hash: z.string().nullable(),
    verification_token_hash: z.string().nullable(),
    verification_sent_at: z.number().nullable(),
    verification_expires_at: z.number().nullable(),
    issuance_locked_at: z.number().nullable(),
    issued_at: z.number().nullable(),
    rejected_at: z.number().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
    claim_status: ApiKeySelfServeClaimStatusSchema.nullable(),
    linked_key_owner_email: z.string().nullable(),
    linked_key_prefix: z.string().nullable(),
    linked_key_tier: z.string().nullable(),
    linked_key_active: z.number().nullable(),
    linked_key_expires_at: z.number().nullable(),
  })
  .passthrough();

function decodeAdminRequestRows(rows: unknown[], route: string): ApiKeyRequestAdminRow[] {
  const decoded: ApiKeyRequestAdminRow[] = [];
  const quarantined: Array<{ requestId: string; field: string }> = [];
  for (const row of rows) {
    const parsed = ApiKeyRequestAdminRowSchema.safeParse(row);
    if (parsed.success) {
      decoded.push(parsed.data as ApiKeyRequestAdminRow);
      continue;
    }
    const requestId = (row as { request_id?: unknown } | null)?.request_id;
    quarantined.push({
      requestId: typeof requestId === "string" ? requestId : "unknown",
      field: parsed.error.issues[0]?.path.join(".") ?? "unknown",
    });
  }
  if (quarantined.length > 0) {
    logWorkerEvent({
      scope: "admin",
      level: "warn",
      event: "api_key_request_admin_row_quarantined",
      route,
      source: "api_key_requests",
      message: "Quarantined malformed self-serve request rows",
      metadata: { quarantinedRows: quarantined.length, rows: quarantined.slice(0, 5) },
    });
  }
  return decoded;
}

export async function selectRequestWithKeyStateByRequestId(
  db: ApiKeyRequestDb,
  requestId: string,
): Promise<ApiKeyRequestAdminRow | null> {
  const row = await db.prepare(
    `${ADMIN_REQUEST_WITH_KEY_STATE_SELECT}
     WHERE r.request_id = ?`,
  )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return decodeAdminRequestRows([row], "api-key-request-by-id")[0] ?? null;
}

export interface ApiKeyRequestAdminCursor {
  createdAt: number;
  id: number;
}

export async function listAdminRequests(
  db: ApiKeyRequestDb,
  status: ApiKeySelfServeStatus | null,
  limit: number,
  cursor: ApiKeyRequestAdminCursor | null,
): Promise<{
  rows: ApiKeyRequestAdminRow[];
  total: number;
  nextCursor: ApiKeyRequestAdminCursor | null;
}> {
  const filters: string[] = [];
  const bindings: unknown[] = [];
  if (status) {
    filters.push("r.status = ?");
    bindings.push(status);
  }
  if (cursor) {
    filters.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const pageQuery = db.prepare(
    `${ADMIN_REQUEST_WITH_KEY_STATE_SELECT}
     ${where}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`,
  )
    .bind(...bindings, limit + 1)
    .all<Record<string, unknown>>();
  const countStatement = db.prepare(
    `SELECT COUNT(*) AS total
     FROM api_key_requests r
     ${status ? "WHERE r.status = ?" : ""}`,
  );
  const countQuery = status
    ? countStatement.bind(status).first<{ total: number }>()
    : countStatement.first<{ total: number }>();
  const [pageResult, countRow] = await Promise.all([pageQuery, countQuery]);
  const pageRows = pageResult.results ?? [];
  const pageWindow = pageRows.slice(0, limit);
  // The cursor advances over the raw page so a quarantined row cannot stall pagination.
  const last = pageRows.length > limit ? pageWindow[pageWindow.length - 1] : null;
  return {
    rows: decodeAdminRequestRows(pageWindow, "api-key-requests-admin"),
    total: countRow?.total ?? 0,
    nextCursor:
      typeof last?.created_at === "number" && typeof last.id === "number"
        ? { createdAt: last.created_at, id: last.id }
        : null,
  };
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
