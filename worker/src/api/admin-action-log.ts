import { jsonResponse } from "../lib/api-utils";
import { makeAdminRoute } from "../lib/route-wrappers";

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

function parseLimit(raw: string | null): number {
  const parsed = Number(raw ?? String(DEFAULT_LIMIT));
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

interface AdminActionLogContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

export const handleAdminActionLog = makeAdminRoute(
  "route-admin-action-log",
  async ({ db, url }: AdminActionLogContext) => {
    const limit = parseLimit(url.searchParams.get("limit"));
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
      details: r.details_json ? safeJsonParse(r.details_json) : null,
    }));
    return jsonResponse({ entries }, { noStore: true });
  },
);
