import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import { withErrorHandler, addFreshnessHeaders, isValidStablecoinId, errorResponse, parseIntParam, jsonResponse } from "../lib/api-utils";
import { buildPaginatedQuery } from "../lib/db";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDepegEvents = withErrorHandler("depeg-events", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const limit = parseIntParam(params.get("limit"), 100, 1, 1000);
  const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const stablecoin = params.get("stablecoin");
  const active = params.get("active");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    if (!isValidStablecoinId(stablecoin)) {
      return errorResponse(400, "Invalid stablecoin ID");
    }
    conditions.push("stablecoin_id = ?");
    filterBindings.push(stablecoin);
  }
  if (active === "true") {
    conditions.push("ended_at IS NULL");
  }

  const { where, limitClause, offsetClause, paginationBindings } = buildPaginatedQuery({
    conditions, limit, offset,
  });

  // Batch COUNT + SELECT for transactional consistency
  const sql = `SELECT * FROM depeg_events${where} ORDER BY started_at DESC${limitClause}${offsetClause}`;

  const [countBatch, dataBatch] = await db.batch([
    db.prepare(`SELECT COUNT(*) as total FROM depeg_events${where}`).bind(...filterBindings),
    db.prepare(sql).bind(...filterBindings, ...paginationBindings),
  ]);
  const total = ((countBatch.results ?? []) as { total: number }[])[0]?.total ?? 0;
  const events = ((dataBatch.results ?? []) as DepegRow[]).map(rowToDepegEvent);

  const latestTs = events.length > 0 ? events[0].startedAt : Math.floor(Date.now() / 1000);

  return jsonResponse({ events, total }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, latestTs, 900));
});
