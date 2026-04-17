import { makeIdempotentAdminRoute } from "../lib/route-wrappers";
import { errorResponse, jsonResponse } from "../lib/api-utils";
import { logAdminAction } from "../lib/admin-action-audit";

interface AdminRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

function parseIds(raw: string | null): number[] | null {
  if (!raw) return null;
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    ids.push(n);
  }
  return ids.length > 0 ? ids : null;
}

export const handleBulkDismissDiscoveryCandidates = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-bulk-dismiss-discovery-candidates",
  "bulk-dismiss-discovery-candidates",
  async ({ db, url, request }) => {
    const all = url.searchParams.get("all") === "true";
    const ids = parseIds(url.searchParams.get("ids"));
    if (!all && !ids) {
      return errorResponse(400, "Missing required param: pass either ?all=true or ?ids=1,2,3");
    }

    let dismissed = 0;
    if (all) {
      const result = await db
        .prepare("UPDATE discovery_candidates SET dismissed = 1 WHERE dismissed = 0")
        .run();
      dismissed = result.meta?.changes ?? 0;
    } else if (ids) {
      const placeholders = ids.map(() => "?").join(",");
      const result = await db
        .prepare(
          `UPDATE discovery_candidates SET dismissed = 1 WHERE dismissed = 0 AND id IN (${placeholders})`,
        )
        .bind(...ids)
        .run();
      dismissed = result.meta?.changes ?? 0;
    }

    await logAdminAction(
      db,
      {
        action: "bulk-dismiss-discovery-candidates",
        result: "ok",
        httpStatus: 200,
        details: { all, ids, dismissed },
      },
      request,
    );
    return jsonResponse({ ok: true, dismissed }, { status: 200, noStore: true });
  },
);
