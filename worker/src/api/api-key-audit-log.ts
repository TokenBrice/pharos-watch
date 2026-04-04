import { withAdmin } from "../lib/auth";
import { jsonResponse, withErrorHandler } from "../lib/api-utils";

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

export const handleApiKeyAuditLog = withErrorHandler(
  "api-key-audit-log",
  async (db: D1Database, trustedAdmin: boolean = false, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {
      const url = new URL(request!.url);
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, AUDIT_LOG_MAX_LIMIT)
        : AUDIT_LOG_DEFAULT_LIMIT;

      const apiKeyIdParam = url.searchParams.get("apiKeyId");
      const apiKeyId = apiKeyIdParam ? Number.parseInt(apiKeyIdParam, 10) : null;

      let rows: AuditLogRow[];
      if (apiKeyId && Number.isFinite(apiKeyId) && apiKeyId > 0) {
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
        detail: row.detail_json ? JSON.parse(row.detail_json) : null,
        createdAt: row.created_at,
      }));

      return jsonResponse({ entries }, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);
