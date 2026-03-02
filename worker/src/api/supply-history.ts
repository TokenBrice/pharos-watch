import { withErrorHandler, isValidStablecoinId, errorResponse, parseIntParam, jsonResponse } from "../lib/api-utils";
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
  const stablecoinId = url.searchParams.get("stablecoin");
  if (!stablecoinId) {
    return errorResponse(400, "Missing ?stablecoin= parameter");
  }
  // Validate ID format to prevent edge cache pollution
  if (!isValidStablecoinId(stablecoinId)) {
    return errorResponse(400, "Invalid stablecoin ID");
  }

  const days = parseIntParam(url.searchParams.get("days"), 365, 1, 1825);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;

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
