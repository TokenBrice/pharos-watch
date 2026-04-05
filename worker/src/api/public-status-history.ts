import { parseQueryParams, withErrorHandler, jsonResponse } from "../lib/api-utils";
import {
  getStatusStateSnapshot,
  listRecentStatusTransitions,
} from "../lib/status-reliability";
import type { PublicStatusHistoryResponse, PublicStatusTransition, StatusTransition } from "@shared/types/status";

const MAX_WINDOW_SEC = 30 * 24 * 60 * 60; // 30 days
const MAX_LIMIT = 50;

function toPublicTransition(t: StatusTransition): PublicStatusTransition {
  return {
    id: t.id,
    from: t.from,
    to: t.to,
    transitionType: t.transitionType,
    reason: t.reason,
    at: t.at,
  };
}

export const handlePublicStatusHistory = withErrorHandler(
  "public-status-history",
  async (db: D1Database, _trustedAdmin?: boolean, request?: Request): Promise<Response> => {
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request?.url ?? "https://pharos.watch/api/public-status-history");
    const parsed = parseQueryParams(url.searchParams, {
      limit: { type: "int", default: 50, min: 1, max: MAX_LIMIT },
    });
    if (parsed instanceof Response) return parsed;

    const from = now - MAX_WINDOW_SEC;

    const [{ state }, transitions] = await Promise.all([
      getStatusStateSnapshot(db, now),
      listRecentStatusTransitions(db, parsed.limit, { from }),
    ]);

    const body: PublicStatusHistoryResponse = {
      timestamp: now,
      currentStatus: state?.currentStatus ?? "healthy",
      lastChangedAt: state?.lastChangedAt ?? null,
      transitions: transitions.map(toPublicTransition),
    };

    return jsonResponse(body, { "Cache-Control": "public, max-age=60" });
  },
);
