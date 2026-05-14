import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { buildInClause, chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../lib/db";
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
}

interface CategoryAggRow {
  snapshot_date: number;
  amount: number;
}

async function readTotalRows(
  db: D1Database,
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): Promise<AggRow[]> {
  const result = await db
    .prepare(
      `SELECT
         snapshot_date,
         ROUND(SUM(circulating_usd), 2) AS total
       FROM supply_history
       WHERE snapshot_date >= ?${latestSnapshotFilter}
       GROUP BY snapshot_date
       ORDER BY snapshot_date ASC`,
    )
    .bind(cutoff, ...latestSnapshotBinds)
    .all<AggRow>();

  return result.results ?? [];
}

async function readCategoryTotalsByDate(
  db: D1Database,
  ids: readonly string[],
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): Promise<Map<number, number>> {
  const totals = new Map<number, number>();

  for (const idChunk of chunkArray(ids, D1_SAFE_IN_CLAUSE_BIND_LIMIT)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      .prepare(
        `SELECT
           snapshot_date,
           ROUND(SUM(circulating_usd), 2) AS amount
         FROM supply_history
         WHERE snapshot_date >= ?${latestSnapshotFilter}
           AND stablecoin_id IN (${inClause.sql})
         GROUP BY snapshot_date`,
      )
      .bind(cutoff, ...latestSnapshotBinds, ...inClause.binds)
      .all<CategoryAggRow>();

    for (const row of result.results ?? []) {
      totals.set(row.snapshot_date, (totals.get(row.snapshot_date) ?? 0) + row.amount);
    }
  }

  return totals;
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

    const [rows, commodityByDate, fiatNonUsdByDate] = await Promise.all([
      readTotalRows(db, cutoff, latestSnapshotFilter, latestSnapshotBinds),
      readCategoryTotalsByDate(db, COMMODITY_IDS, cutoff, latestSnapshotFilter, latestSnapshotBinds),
      readCategoryTotalsByDate(db, FIAT_NON_USD_IDS, cutoff, latestSnapshotFilter, latestSnapshotBinds),
    ]);

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
        const commodity = commodityByDate.get(row.snapshot_date) ?? 0;
        const fiatNonUsd = fiatNonUsdByDate.get(row.snapshot_date) ?? 0;
        points.push({
          date: row.snapshot_date,
          commodityShare: Math.round(((commodity / row.total) * 100) * 10000) / 10000,
          fiatNonUsdShare: Math.round(((fiatNonUsd / row.total) * 100) * 10000) / 10000,
          commodity,
          fiatNonUsd,
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
