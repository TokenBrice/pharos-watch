import { withErrorHandler, parseStablecoinHistoryQuery, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

interface SupplyHistoryRow {
  snapshot_date: number;
  circulating_usd: number;
  price: number | null;
}

export const handleSupplyHistory = withErrorHandler("supply-history", async (
  db: D1Database,
  url: URL
): Promise<Response> => {
  const parsed = parseStablecoinHistoryQuery(url, {
    defaultDays: 365,
    minDays: 1,
    maxDays: 1825,
  });
  if (parsed instanceof Response) {
    return parsed;
  }
  const { stablecoinId, cutoff } = parsed;

  const result = await db
    .prepare(
      `SELECT snapshot_date, circulating_usd, price
       FROM supply_history
       WHERE stablecoin_id = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`
    )
    .bind(stablecoinId, cutoff)
    .all<SupplyHistoryRow>();

  const history = (result.results ?? []).map((row) => ({
    date: row.snapshot_date,
    circulatingUsd: row.circulating_usd,
    price: row.price,
  }));

  return jsonResponse(history, { "Cache-Control": CACHE_PROFILES.slow });
});
