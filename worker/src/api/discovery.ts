import { jsonResponse, errorResponse, parseIntParam, withErrorHandler } from "../lib/api-utils";
import type { DiscoveryCandidate } from "@shared/types";

function parseDiscoveryStatus(value: string | null): "active" | "dismissed" | "all" {
  switch (value) {
    case "dismissed":
    case "all":
      return value;
    default:
      return "active";
  }
}

export const handleDiscoveryCandidates = withErrorHandler("discovery-candidates", async (
  db: D1Database,
  url: URL,
): Promise<Response> => {
  const status = url.searchParams.get("status") ?? "active";
  const parsedStatus = parseDiscoveryStatus(status);
  const limit = parseIntParam(url.searchParams.get("limit"), 50, 1, 200, "limit");
  if (limit instanceof Response) {
    return limit;
  }
  const offset = parseIntParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  if (offset instanceof Response) {
    return offset;
  }

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
      `SELECT * FROM discovery_candidates ${whereClause} ORDER BY market_cap DESC LIMIT ? OFFSET ?`,
    ).bind(limit, offset).all(),
    db.prepare(
      `SELECT COUNT(*) as total FROM discovery_candidates ${whereClause}`,
    ).all(),
  ]);

  const candidates: DiscoveryCandidate[] = (rows.results ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as number,
    geckoId: row.gecko_id as string | null,
    llamaId: row.llama_id as number | null,
    name: row.name as string,
    symbol: row.symbol as string,
    marketCap: row.market_cap as number | null,
    source: row.source as "defillama" | "coingecko" | "both",
    firstSeen: row.first_seen as number,
    lastSeen: row.last_seen as number,
    daysSeen: Math.max(1, Math.floor((nowSec - (row.first_seen as number)) / 86400)),
    dismissed: (row.dismissed as number) === 1,
  }));

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
