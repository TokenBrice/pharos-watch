import { jsonResponse, errorResponse, parseQueryParams, withErrorHandler } from "../lib/api-utils";
import type { DiscoveryCandidate } from "@shared/types/status";
import {
  DISCOVERY_CANDIDATE_SELECT_COLUMNS,
  mapDiscoveryCandidateRow,
  type DiscoveryCandidateRow,
} from "../lib/discovery-candidates";
import { logAdminAction } from "../lib/admin-action-audit";

interface DiscoveryDismissRow {
  id: number;
  name: string;
  symbol: string;
  source: string;
  market_cap: number | null;
  dismissed: number;
}

function dismissalIdentity(row: DiscoveryDismissRow) {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    source: row.source,
    marketCap: row.market_cap,
  };
}

function parseDiscoveryStatus(value: string | null): "active" | "dismissed" | "all" | Response {
  if (value == null) {
    return "active";
  }
  switch (value) {
    case "active":
    case "dismissed":
    case "all":
      return value;
    default:
      return errorResponse(400, "Invalid status parameter");
  }
}

export const handleDiscoveryCandidates = withErrorHandler("discovery-candidates", async (
  db: D1Database,
  url: URL,
): Promise<Response> => {
  const parsedStatus = parseDiscoveryStatus(url.searchParams.get("status"));
  if (parsedStatus instanceof Response) {
    return parsedStatus;
  }
  const parsed = parseQueryParams(url.searchParams, {
    limit: { type: "int", default: 50, min: 1, max: 200 },
    offset: { type: "int", default: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
  });
  if (parsed instanceof Response) return parsed;
  const { limit, offset } = parsed;

  let whereClause: string;
  switch (parsedStatus) {
    case "dismissed":
      whereClause = "WHERE dismissed = 1";
      break;
    case "all":
      whereClause = "";
      break;
    default:
      whereClause = "WHERE dismissed = 0";
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const [rows, countResult] = await Promise.all([
    db.prepare(
      `SELECT ${DISCOVERY_CANDIDATE_SELECT_COLUMNS} FROM discovery_candidates ${whereClause} ORDER BY market_cap DESC LIMIT ? OFFSET ?`,
    ).bind(limit, offset).all<DiscoveryCandidateRow>(),
    db.prepare(
      `SELECT COUNT(*) as total FROM discovery_candidates ${whereClause}`,
    ).all<{ total: number }>(),
  ]);

  const candidates: DiscoveryCandidate[] = (rows.results ?? []).map((row) =>
    mapDiscoveryCandidateRow(row, nowSec)
  );

  const total = countResult.results?.[0]?.total ?? 0;

  return jsonResponse({ candidates, total });
});

export const handleDismissCandidate = withErrorHandler("dismiss-discovery-candidate", async (
  db: D1Database,
  candidateId: number,
  request?: Request,
): Promise<Response> => {
  const nowSec = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare("SELECT id, name, symbol, source, market_cap, dismissed FROM discovery_candidates WHERE id = ?")
    .bind(candidateId)
    .first<DiscoveryDismissRow>();

  if (!existing) {
    return errorResponse(404, "Discovery candidate not found");
  }
  if (existing.dismissed === 1) {
    return jsonResponse({ ok: true, alreadyDismissed: true, candidate: dismissalIdentity(existing) });
  }

  const result = await db.prepare(`
    UPDATE discovery_candidates
    SET dismissed = 1, dismissed_at = ?, dismissed_mcap = market_cap
    WHERE id = ? AND dismissed = 0
  `).bind(nowSec, candidateId).run();

  if ((result.meta.changes ?? 0) === 0) {
    const reconciled = await db
      .prepare("SELECT id, name, symbol, source, market_cap, dismissed FROM discovery_candidates WHERE id = ?")
      .bind(candidateId)
      .first<DiscoveryDismissRow>();
    if (reconciled?.dismissed === 1) {
      return jsonResponse({ ok: true, alreadyDismissed: true, candidate: dismissalIdentity(reconciled) });
    }
    return errorResponse(409, "Discovery candidate dismissal did not commit");
  }

  const candidate = dismissalIdentity(existing);
  await logAdminAction(db, {
    action: "dismiss-discovery-candidate",
    target: `candidate:${candidateId}`,
    result: "ok",
    httpStatus: 200,
    details: {
      candidate,
      effect: "removed-from-active-discovery-queue",
      idempotencyKey: request?.headers.get("Idempotency-Key") ?? null,
    },
  }, request);

  return jsonResponse({
    ok: true,
    alreadyDismissed: false,
    candidate,
    auditAction: "dismiss-discovery-candidate",
  });
});
