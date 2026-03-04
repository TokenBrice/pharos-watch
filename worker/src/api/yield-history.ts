import { withErrorHandler, parseStablecoinHistoryQuery, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

interface YieldHistoryRow {
  recorded_at: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  exchange_rate: number | null;
  source_tvl_usd: number | null;
}

/**
 * GET /api/yield-history?stablecoin=<id>&days=<n>
 * Returns historical yield data points for a given stablecoin.
 */
export const handleYieldHistory = withErrorHandler("yield-history", async (
  db: D1Database,
  url: URL,
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

  const result = await db
    .prepare(
      `SELECT recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ?
       ORDER BY recorded_at ASC`
    )
    .bind(stablecoinId, cutoff)
    .all<YieldHistoryRow>();

  const history = (result.results ?? []).map((row) => ({
    date: row.recorded_at,
    apy: row.apy,
    apyBase: row.apy_base,
    apyReward: row.apy_reward,
    exchangeRate: row.exchange_rate,
    sourceTvlUsd: row.source_tvl_usd,
  }));

  return jsonResponse(history, { "Cache-Control": CACHE_PROFILES.slow });
});
