import { jsonResponse } from "../lib/api-response";
import { parseOptionalPositiveIntegerParam } from "../lib/api-params";
import { runAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";
import { loadAdminAuditPage, type AdminAuditPageDescriptor } from "./admin-audit-page";

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

const API_KEY_AUDIT_PAGE = {
  unfilteredSql: `SELECT id, api_key_id, action, actor, detail_json, created_at
           FROM api_key_audit_log
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
  filteredSql: `SELECT id, api_key_id, action, actor, detail_json, created_at
           FROM api_key_audit_log
           WHERE api_key_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
  detailJson: (row) => row.detail_json,
  rowId: (row) => row.id,
  malformedDetailLog: "api-key",
  detailContext: "api-key-audit-log",
  mapRow: (row, detail) => ({
    id: row.id,
    apiKeyId: row.api_key_id,
    action: row.action,
    actor: row.actor,
    detail,
    createdAt: row.created_at,
  }),
} satisfies AdminAuditPageDescriptor<AuditLogRow, {
  id: number;
  apiKeyId: number;
  action: string;
  actor: string;
  detail: unknown;
  createdAt: number;
}>;

export function handleApiKeyAuditLog({ db, trustedAdmin, request }: AdminRouteContext): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-audit-log",
      request,
      trustedAdmin,
    },
    async () => {
      const url = new URL(request.url);
      const limitParam = parseOptionalPositiveIntegerParam(url.searchParams.get("limit"), "limit", {
        max: AUDIT_LOG_MAX_LIMIT,
      });
      if (limitParam instanceof Response) return limitParam;
      const limit = limitParam == null ? AUDIT_LOG_DEFAULT_LIMIT : limitParam;

      const apiKeyIdParam = url.searchParams.get("apiKeyId");
      const apiKeyId = parseOptionalPositiveIntegerParam(apiKeyIdParam, "apiKeyId");
      if (apiKeyId instanceof Response) return apiKeyId;

      const entries = await loadAdminAuditPage(db, {
        descriptor: API_KEY_AUDIT_PAGE,
        limit,
        ...(apiKeyId == null ? {} : { filterValue: apiKeyId }),
      });

      return jsonResponse({ entries });
    },
  );
}
