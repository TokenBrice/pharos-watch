import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import { withErrorHandler } from "../lib/api-utils";
import { buildPaginatedQuery } from "../lib/db";

export const handleDepegEvents = withErrorHandler("depeg-events", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const limit = Math.min(Math.max(parseInt(params.get("limit") ?? "0", 10) || 0, 0), 1000);
  const offset = Math.max(parseInt(params.get("offset") ?? "0", 10) || 0, 0);
  const stablecoin = params.get("stablecoin");
  const active = params.get("active");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    conditions.push("stablecoin_id = ?");
    filterBindings.push(stablecoin);
  }
  if (active === "true") {
    conditions.push("ended_at IS NULL");
  }

  const { where, limitClause, offsetClause, paginationBindings } = buildPaginatedQuery({
    conditions, bindings: filterBindings, limit, offset,
  });

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM depeg_events${where}`)
    .bind(...filterBindings)
    .first<{ total: number }>();
  const total = countResult?.total ?? 0;

  const sql = `SELECT * FROM depeg_events${where} ORDER BY started_at DESC${limitClause}${offsetClause}`;

  const result = await db
    .prepare(sql)
    .bind(...filterBindings, ...paginationBindings)
    .all<DepegRow>();

  const events = (result.results ?? []).map(rowToDepegEvent);

  return new Response(JSON.stringify({ events, total }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=60, max-age=10",
    },
  });
});
