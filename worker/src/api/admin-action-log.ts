import { jsonResponse } from "../lib/api-response";
import { parseClampedIntegerParam } from "../lib/api-params";
import { makeAdminRoute, type AdminUrlRouteContext } from "../lib/route-wrappers";
import { loadAdminAuditPage, type AdminAuditPageDescriptor } from "./admin-audit-page";

interface AdminActionAuditRow {
  id: number;
  created_at: number;
  actor: string;
  action: string;
  target: string | null;
  result: "ok" | "error";
  http_status: number | null;
  details_json: string | null;
}

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

const ADMIN_ACTION_AUDIT_PAGE = {
  unfilteredSql: "SELECT id, created_at, actor, action, target, result, http_status, details_json FROM admin_action_audit ORDER BY created_at DESC, id DESC LIMIT ?",
  detailJson: (row) => row.details_json,
  rowId: (row) => row.id,
  malformedDetailLog: "cache",
  detailContext: "admin-action-log",
  mapRow: (row, details) => ({
    id: row.id,
    at: row.created_at,
    actor: row.actor,
    action: row.action,
    target: row.target,
    result: row.result,
    httpStatus: row.http_status,
    details,
  }),
} satisfies AdminAuditPageDescriptor<AdminActionAuditRow, {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  result: "ok" | "error";
  httpStatus: number | null;
  details: unknown;
}>;

export const handleAdminActionLog = makeAdminRoute<AdminUrlRouteContext>(
  "route-admin-action-log",
  async ({ db, url }) => {
    const limit = parseClampedIntegerParam(url.searchParams.get("limit"), DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
    const entries = await loadAdminAuditPage(db, { descriptor: ADMIN_ACTION_AUDIT_PAGE, limit });
    return jsonResponse({ entries });
  },
);
