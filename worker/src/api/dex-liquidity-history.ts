import { withErrorHandler, parseStablecoinHistoryQuery, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getLiquidityMethodologyVersionAt } from "../../../src/lib/liquidity-score-version";

interface LiquidityHistoryRow {
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
  methodology_version: string | null;
}

export const handleDexLiquidityHistory = withErrorHandler("dex-liquidity-history", async (
  db: D1Database,
  url: URL
): Promise<Response> => {
  const parsed = parseStablecoinHistoryQuery(url, {
    defaultDays: 90,
    minDays: 1,
    maxDays: 365,
  });
  if (parsed instanceof Response) {
    return parsed;
  }
  const { stablecoinId, cutoff } = parsed;

  let result: D1Result<LiquidityHistoryRow>;
  try {
    result = await db
      .prepare(
        `SELECT total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date, methodology_version
         FROM dex_liquidity_history
         WHERE stablecoin_id = ? AND snapshot_date >= ?
         ORDER BY snapshot_date ASC`
      )
      .bind(stablecoinId, cutoff)
      .all<LiquidityHistoryRow>();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("methodology_version")) throw err;
    result = await db
      .prepare(
        `SELECT total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date
         FROM dex_liquidity_history
         WHERE stablecoin_id = ? AND snapshot_date >= ?
         ORDER BY snapshot_date ASC`
      )
      .bind(stablecoinId, cutoff)
      .all<LiquidityHistoryRow>();
  }

  const history = (result.results ?? []).map((row) => ({
    tvl: row.total_tvl_usd,
    volume24h: row.total_volume_24h_usd,
    score: row.liquidity_score,
    date: row.snapshot_date,
    methodologyVersion: row.methodology_version ?? getLiquidityMethodologyVersionAt(row.snapshot_date),
  }));

  return jsonResponse(history, { "Cache-Control": CACHE_PROFILES.slow });
});
