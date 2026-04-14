import { errorResponse, jsonResponse } from "../lib/api-utils";
import { runAdminRoute } from "../lib/route-wrappers";

interface AuditLogRow {
  id: number;
  api_key_id: number;
  action: string;
  actor: string;
  detail_json: string | null;
  created_at: number;
}

const AUDIT_LOG_DEFAULT_LIMIT = 50;
const AUDIT_LOG_MAX_LIMIT = 200;
const POSITIVE_INTEGER_PATTERN = /^\d+$/;

function parseAuditDetail(row: AuditLogRow): unknown {
  if (!row.detail_json) return null;
  try {
    return JSON.parse(row.detail_json) as unknown;
  } catch (error) {
    console.warn(
      `[api-key-audit-log] Failed to parse detail_json for row ${row.id}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function parsePositiveIntParam(value: string | null, fieldName: string): number | Response | null {
  if (value == null || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (!POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    return errorResponse(400, `Invalid ${fieldName}: must be a positive integer`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return errorResponse(400, `Invalid ${fieldName}: must be a positive integer`);
  }
  return parsed;
}

export function handleApiKeyAuditLog(
  db: D1Database,
  trustedAdmin: boolean = false,
  request?: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-audit-log",
      request,
      trustedAdmin,
    },
    async () => {
      const url = new URL(request!.url);
      const limitParam = parsePositiveIntParam(url.searchParams.get("limit"), "limit");
      if (limitParam instanceof Response) return limitParam;
      const limit = limitParam == null ? AUDIT_LOG_DEFAULT_LIMIT : Math.min(limitParam, AUDIT_LOG_MAX_LIMIT);

      const apiKeyIdParam = url.searchParams.get("apiKeyId");
      const apiKeyId = parsePositiveIntParam(apiKeyIdParam, "apiKeyId");
      if (apiKeyId instanceof Response) return apiKeyId;

      let rows: AuditLogRow[];
      if (apiKeyId != null) {
        const result = await db.prepare(
          `SELECT id, api_key_id, action, actor, detail_json, created_at
           FROM api_key_audit_log
           WHERE api_key_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
          .bind(apiKeyId, limit)
          .all<AuditLogRow>();
        rows = result.results ?? [];
      } else {
        const result = await db.prepare(
          `SELECT id, api_key_id, action, actor, detail_json, created_at
           FROM api_key_audit_log
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
          .bind(limit)
          .all<AuditLogRow>();
        rows = result.results ?? [];
      }

      const entries = rows.map((row) => ({
        id: row.id,
        apiKeyId: row.api_key_id,
        action: row.action,
        actor: row.actor,
        detail: parseAuditDetail(row),
        createdAt: row.created_at,
      }));

      return jsonResponse({ entries }, { noStore: true });
    },
  );
}
