import { withErrorHandler, handleStablecoinHistoryRequest } from "../lib/api-utils";
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
  return handleStablecoinHistoryRequest(db, url, {
    query: {
      defaultDays: 90,
      minDays: 1,
      maxDays: 365,
    },
    cacheControl: CACHE_PROFILES.slow,
    fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
      const result = await database
        .prepare(
          `SELECT recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd
           FROM yield_history
           WHERE stablecoin_id = ? AND recorded_at >= ?
           ORDER BY recorded_at ASC`
        )
        .bind(stablecoinId, cutoff)
        .all<YieldHistoryRow>();
      return result.results ?? [];
    },
    mapRow: (row) => ({
      date: row.recorded_at,
      apy: row.apy,
      apyBase: row.apy_base,
      apyReward: row.apy_reward,
      exchangeRate: row.exchange_rate,
      sourceTvlUsd: row.source_tvl_usd,
    }),
  });
});
