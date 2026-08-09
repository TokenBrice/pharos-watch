import { jsonResponse, parseClampedIntegerParam, safeJsonParse } from "../lib/api-utils";
import { makeAdminRoute, type AdminUrlRouteContext } from "../lib/route-wrappers";

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

export const handleAdminActionLog = makeAdminRoute<AdminUrlRouteContext>(
  "route-admin-action-log",
  async ({ db, url }) => {
    const limit = parseClampedIntegerParam(url.searchParams.get("limit"), DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
    const rows = await db
      .prepare(
        "SELECT id, created_at, actor, action, target, result, http_status, details_json FROM admin_action_audit ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .bind(limit)
      .all<AdminActionAuditRow>();
    const entries = (rows.results ?? []).map((r) => ({
      id: r.id,
      at: r.created_at,
      actor: r.actor,
      action: r.action,
      target: r.target,
      result: r.result,
      httpStatus: r.http_status,
      details: safeJsonParse<unknown>(r.details_json, null, `admin-action-log:${r.id}:details_json`),
    }));
    return jsonResponse({ entries });
  },
);
