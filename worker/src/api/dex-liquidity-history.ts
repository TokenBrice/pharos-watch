import { withErrorHandler, isValidStablecoinId, errorResponse, parseIntParam, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

interface LiquidityHistoryRow {
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
}

export const handleDexLiquidityHistory = withErrorHandler("dex-liquidity-history", async (
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

  const days = parseIntParam(url.searchParams.get("days"), 90, 1, 365);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;

  const result = await db
    .prepare(
      `SELECT total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date
       FROM dex_liquidity_history
       WHERE stablecoin_id = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`
    )
    .bind(stablecoinId, cutoff)
    .all<LiquidityHistoryRow>();

  const history = (result.results ?? []).map((row) => ({
    tvl: row.total_tvl_usd,
    volume24h: row.total_volume_24h_usd,
    score: row.liquidity_score,
    date: row.snapshot_date,
  }));

  return jsonResponse(history, { "Cache-Control": CACHE_PROFILES.slow });
});
