import { jsonResponse, errorResponse, parseQueryParams, withErrorHandler } from "../lib/api-utils";
import type { DiscoveryCandidate } from "@shared/types/status";
import {
  DISCOVERY_CANDIDATE_SELECT_COLUMNS,
  mapDiscoveryCandidateRow,
  type DiscoveryCandidateRow,
} from "../lib/discovery-candidates";

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
    ).all(),
  ]);

  const candidates: DiscoveryCandidate[] = (rows.results ?? []).map((row) =>
    mapDiscoveryCandidateRow(row, nowSec)
  );

  const total = ((countResult.results?.[0] as Record<string, unknown>)?.total as number) ?? 0;

  return jsonResponse({ candidates, total });
});

export const handleDismissCandidate = withErrorHandler("dismiss-discovery-candidate", async (
  db: D1Database,
  candidateId: number,
): Promise<Response> => {
  const nowSec = Math.floor(Date.now() / 1000);

  const result = await db.prepare(`
    UPDATE discovery_candidates
    SET dismissed = 1, dismissed_at = ?, dismissed_mcap = market_cap
    WHERE id = ? AND dismissed = 0
  `).bind(nowSec, candidateId).run();

  if ((result.meta.changes ?? 0) === 0) {
    return errorResponse(404, "Candidate not found or already dismissed");
  }

  return jsonResponse({ ok: true });
});
