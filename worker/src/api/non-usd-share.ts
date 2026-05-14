import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  addFreshnessHeaders,
  jsonResponse,
  parseClampedIntegerParam,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCompletedSupplySnapshot } from "../lib/supply-snapshot-completion";

const COMMODITY_PEGS = new Set(["GOLD", "SILVER"]);
const DEFAULT_DAYS = 1825;
const MIN_DAYS = 30;
const MAX_DAYS = 1825;

/** IDs of commodity-pegged stablecoins (gold, silver). */
const COMMODITY_IDS = ACTIVE_STABLECOINS
  .filter((c) => COMMODITY_PEGS.has(c.flags.pegCurrency))
  .map((c) => c.id);

/** IDs of fiat non-USD stablecoins (EUR, GBP, BRL, VAR, etc.). */
const FIAT_NON_USD_IDS = ACTIVE_STABLECOINS
  .filter((c) => c.flags.pegCurrency !== "USD" && !COMMODITY_PEGS.has(c.flags.pegCurrency))
  .map((c) => c.id);

interface AggRow {
  snapshot_date: number;
  total: number;
  commodity: number;
  fiat_non_usd: number;
}

async function readRows(
  db: D1Database,
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): Promise<AggRow[]> {
  const result = await db
    .prepare(
      `WITH
         commodity_ids(id) AS (SELECT value FROM json_each(?)),
         fiat_non_usd_ids(id) AS (SELECT value FROM json_each(?))
       SELECT
         snapshot_date,
         ROUND(SUM(circulating_usd), 2) AS total,
         ROUND(SUM(CASE WHEN stablecoin_id IN (SELECT id FROM commodity_ids) THEN circulating_usd ELSE 0 END), 2) AS commodity,
         ROUND(SUM(CASE WHEN stablecoin_id IN (SELECT id FROM fiat_non_usd_ids) THEN circulating_usd ELSE 0 END), 2) AS fiat_non_usd
       FROM supply_history
       WHERE snapshot_date >= ?${latestSnapshotFilter}
       GROUP BY snapshot_date
       ORDER BY snapshot_date ASC`,
    )
    .bind(JSON.stringify(COMMODITY_IDS), JSON.stringify(FIAT_NON_USD_IDS), cutoff, ...latestSnapshotBinds)
    .all<AggRow>();

  return result.results ?? [];
}

export const handleNonUsdShare = withErrorHandler(
  "non-usd-share",
  async (db: D1Database, url: URL): Promise<Response> => {
    const days = parseClampedIntegerParam(url.searchParams.get("days"), DEFAULT_DAYS, MIN_DAYS, MAX_DAYS, {
      zeroAsDefault: true,
    });
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const completedSnapshot = await getCompletedSupplySnapshot(db);
    const latestSnapshotFilter = completedSnapshot == null ? "" : " AND snapshot_date <= ?";
    const latestSnapshotBinds = completedSnapshot == null ? [] : [completedSnapshot.snapshotDate];

    const rows = await readRows(db, cutoff, latestSnapshotFilter, latestSnapshotBinds);

    // Downsample: daily for last 90d, weekly for last 2y, monthly beyond
    const nowSec = Math.floor(Date.now() / 1000);
    const ninetyDaysAgo = nowSec - 90 * 86400;
    const twoYearsAgo = nowSec - 2 * 365 * 86400;

    const points: Array<{
      date: number;
      commodityShare: number;
      fiatNonUsdShare: number;
      commodity: number;
      fiatNonUsd: number;
      total: number;
    }> = [];
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
          commodityShare: Math.round(((row.commodity / row.total) * 100) * 10000) / 10000,
          fiatNonUsdShare: Math.round(((row.fiat_non_usd / row.total) * 100) * 10000) / 10000,
          commodity: row.commodity,
          fiatNonUsd: row.fiat_non_usd,
          total: row.total,
        });
        lastKeptDate = row.snapshot_date;
      }
    }

    const latestPointDate = points.reduce<number | null>(
      (latest, point) => latest == null ? point.date : Math.max(latest, point.date),
      null,
    );
    const updatedAt = completedSnapshot?.updatedAt ?? latestPointDate;
    const headers = updatedAt == null
      ? { "Cache-Control": CACHE_PROFILES.slow }
      : addFreshnessHeaders(
        { "Cache-Control": CACHE_PROFILES.slow },
        updatedAt,
        API_FRESHNESS_MAX_AGE_SEC.nonUsdShare,
      );

    return jsonResponse(points, headers);
  },
);
