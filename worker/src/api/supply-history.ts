import { withErrorHandler, handleStablecoinHistoryRequest } from "../lib/api-utils";
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
  return handleStablecoinHistoryRequest(db, url, {
    query: {
      defaultDays: 365,
      minDays: 1,
      maxDays: 1825,
    },
    cacheControl: CACHE_PROFILES.slow,
    fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
      const result = await database
        .prepare(
          `SELECT snapshot_date, circulating_usd, price
           FROM supply_history
           WHERE stablecoin_id = ? AND snapshot_date >= ?
           ORDER BY snapshot_date ASC`
        )
        .bind(stablecoinId, cutoff)
        .all<SupplyHistoryRow>();
      return result.results ?? [];
    },
    mapRow: (row) => ({
      date: row.snapshot_date,
      circulatingUsd: row.circulating_usd,
      price: row.price,
    }),
  });
});
