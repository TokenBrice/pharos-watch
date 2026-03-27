import { jsonResponse, errorResponse, parseQueryParams, withErrorHandler } from "../lib/api-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { DiscoveryCandidate } from "@shared/types/status";

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
      `SELECT id, gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen, dismissed FROM discovery_candidates ${whereClause} ORDER BY market_cap DESC LIMIT ? OFFSET ?`,
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
    daysSeen: Math.max(1, Math.floor((nowSec - (row.first_seen as number)) / DAY_SECONDS)),
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
