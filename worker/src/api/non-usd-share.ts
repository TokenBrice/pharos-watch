import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { buildInClause } from "../lib/db";
import { jsonResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

/** IDs of all active non-USD stablecoins (fiat non-USD + commodity + VAR). */
const NON_USD_IDS = ACTIVE_STABLECOINS
  .filter((c) => c.flags.pegCurrency !== "USD")
  .map((c) => c.id);

interface AggRow {
  snapshot_date: number;
  total: number;
  non_usd: number;
}

export const handleNonUsdShare = withErrorHandler(
  "non-usd-share",
  async (db: D1Database, url: URL): Promise<Response> => {
    const daysParam = url.searchParams.get("days");
    const days = Math.min(Math.max(Number(daysParam) || 1825, 30), 1825);
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const inClause = buildInClause(NON_USD_IDS);

    const result = await db
      .prepare(
        `SELECT
           snapshot_date,
           ROUND(SUM(circulating_usd), 2) AS total,
           ROUND(SUM(CASE WHEN stablecoin_id IN (${inClause.sql}) THEN circulating_usd ELSE 0 END), 2) AS non_usd
         FROM supply_history
         WHERE snapshot_date >= ?
         GROUP BY snapshot_date
         ORDER BY snapshot_date ASC`,
      )
      .bind(...inClause.binds, cutoff)
      .all<AggRow>();

    const rows = result.results ?? [];

    // Downsample: daily for last 90d, weekly for last 2y, monthly beyond
    const nowSec = Math.floor(Date.now() / 1000);
    const ninetyDaysAgo = nowSec - 90 * 86400;
    const twoYearsAgo = nowSec - 2 * 365 * 86400;

    const points: Array<{ date: number; share: number; nonUsd: number; total: number }> = [];
    let lastKeptDate = 0;

    for (const row of rows) {
      if (row.total <= 0) continue;

      let interval: number;
      if (row.snapshot_date >= ninetyDaysAgo) {
        interval = 86400; // daily
      } else if (row.snapshot_date >= twoYearsAgo) {
        interval = 7 * 86400; // weekly
      } else {
        interval = 30 * 86400; // monthly
      }

      if (row.snapshot_date - lastKeptDate >= interval) {
        points.push({
          date: row.snapshot_date,
          share: Math.round(((row.non_usd / row.total) * 100) * 10000) / 10000,
          nonUsd: row.non_usd,
          total: row.total,
        });
        lastKeptDate = row.snapshot_date;
      }
    }

    return jsonResponse(points, {
      "Cache-Control": CACHE_PROFILES.slow,
    });
  },
);
