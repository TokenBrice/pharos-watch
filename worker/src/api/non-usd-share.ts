import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CORE_AGGREGATE_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/aggregate-registry";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { NonUsdShareResponseSchema, type NonUsdSharePoint } from "@shared/types/market";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { errorResponse, jsonResponseWithHeaders } from "../lib/api-response";
import { parseQueryParams } from "../lib/api-params";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { getCompletedSupplySnapshot } from "../lib/supply-snapshot-completion";

const DEFAULT_DAYS = 5000;
const MIN_DAYS = 30;
const MAX_DAYS = 5000;

/** IDs of commodity-pegged stablecoins (gold, silver). */
const CORE_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.map((c) => c.id);

const COMMODITY_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter((c) => isCommodityPeg(c.flags.pegCurrency)).map(
  (c) => c.id,
);

/** IDs of fiat non-USD stablecoins (EUR, GBP, BRL, VAR, etc.). */
const FIAT_NON_USD_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter(
  (c) => c.flags.pegCurrency !== "USD" && !isCommodityPeg(c.flags.pegCurrency),
).map((c) => c.id);

const COMMODITY_ID_SET = new Set(COMMODITY_IDS);
const FIAT_NON_USD_ID_SET = new Set(FIAT_NON_USD_IDS);

// A day is published only when the core assets observed on both sides of it but
// missing on it (valued at their previous row) leave its total and each non-USD
// cohort mostly observed. The daily snapshot is all-or-nothing, so a partial day is
// a missed snapshot that later received per-coin backfill rows only; publishing it
// charts a near-empty market as a real share (2026-08-06 plotted a 0% share).
// Measured genuine per-coin holes stay far above these floors (total >= 99.4%,
// cohorts >= 82% across 2015-02-25..2026-09-29).
const MIN_PUBLISHED_TOTAL_COVERAGE = 0.95;
const MIN_PUBLISHED_COHORT_COVERAGE = 0.5;

interface AggRow {
  snapshot_date: number;
  total: number;
  commodity: number;
  fiat_non_usd: number;
}

interface CoinHistoryGapRow {
  stablecoin_id: string;
  previous_date: number;
  next_date: number;
  previous_usd: number;
}

interface UnobservedValue {
  total: number;
  commodity: number;
  fiatNonUsd: number;
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
         core_ids(id) AS (SELECT value FROM json_each(?)),
         commodity_ids(id) AS (SELECT value FROM json_each(?)),
         fiat_non_usd_ids(id) AS (SELECT value FROM json_each(?))
       SELECT
         snapshot_date,
         ROUND(SUM(circulating_usd), 2) AS total,
         ROUND(SUM(CASE WHEN stablecoin_id IN (SELECT id FROM commodity_ids) THEN circulating_usd ELSE 0 END), 2) AS commodity,
         ROUND(SUM(CASE WHEN stablecoin_id IN (SELECT id FROM fiat_non_usd_ids) THEN circulating_usd ELSE 0 END), 2) AS fiat_non_usd
       FROM supply_history
       WHERE stablecoin_id IN (SELECT id FROM core_ids)
         AND snapshot_date >= ?${latestSnapshotFilter}
       GROUP BY snapshot_date
       ORDER BY snapshot_date ASC`,
    )
    .bind(
      JSON.stringify(CORE_IDS),
      JSON.stringify(COMMODITY_IDS),
      JSON.stringify(FIAT_NON_USD_IDS),
      cutoff,
      ...latestSnapshotBinds,
    )
    .all<AggRow>();

  return result.results ?? [];
}

/** Per-coin interior gaps: consecutive rows of one asset more than a day apart. */
async function readCoinHistoryGaps(
  db: D1Database,
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): Promise<CoinHistoryGapRow[]> {
  const result = await db
    .prepare(
      `WITH
         core_ids(id) AS (SELECT value FROM json_each(?)),
         bounded_history AS (
           SELECT stablecoin_id, snapshot_date, circulating_usd
           FROM supply_history
           WHERE stablecoin_id IN (SELECT id FROM core_ids)
             AND snapshot_date >= ?${latestSnapshotFilter}
           UNION ALL
           SELECT history.stablecoin_id, history.snapshot_date, history.circulating_usd
           FROM core_ids
           JOIN supply_history history ON history.stablecoin_id = core_ids.id
             AND history.snapshot_date = (
               SELECT MAX(snapshot_date) FROM supply_history
               WHERE stablecoin_id = core_ids.id AND snapshot_date < ?${latestSnapshotFilter}
             )
         ),
         coin_history AS (
           SELECT
             stablecoin_id,
             snapshot_date,
             LAG(snapshot_date) OVER by_coin AS previous_date,
             LAG(circulating_usd) OVER by_coin AS previous_usd
           FROM bounded_history
           WINDOW by_coin AS (PARTITION BY stablecoin_id ORDER BY snapshot_date)
         )
       SELECT stablecoin_id, previous_date, snapshot_date AS next_date, previous_usd
       FROM coin_history
       WHERE snapshot_date >= ? AND snapshot_date - previous_date > ${DAY_SECONDS}`,
    )
    .bind(JSON.stringify(CORE_IDS), cutoff, ...latestSnapshotBinds, cutoff, ...latestSnapshotBinds, cutoff)
    .all<CoinHistoryGapRow>();

  return result.results ?? [];
}

/**
 * Value of assets missing on each published date although observed before and
 * after it. `rows` must be sorted by `snapshot_date` ascending.
 */
function sumUnobservedValueByDate(
  rows: readonly AggRow[],
  gaps: readonly CoinHistoryGapRow[],
): Map<number, UnobservedValue> {
  const unobservedByDate = new Map<number, UnobservedValue>();
  for (const gap of gaps) {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rows[mid]!.snapshot_date <= gap.previous_date) low = mid + 1;
      else high = mid;
    }
    for (let index = low; index < rows.length && rows[index]!.snapshot_date < gap.next_date; index++) {
      const date = rows[index]!.snapshot_date;
      const unobserved = unobservedByDate.get(date) ?? { total: 0, commodity: 0, fiatNonUsd: 0 };
      unobserved.total += gap.previous_usd;
      if (COMMODITY_ID_SET.has(gap.stablecoin_id)) unobserved.commodity += gap.previous_usd;
      else if (FIAT_NON_USD_ID_SET.has(gap.stablecoin_id)) unobserved.fiatNonUsd += gap.previous_usd;
      unobservedByDate.set(date, unobserved);
    }
  }
  return unobservedByDate;
}

function observedShare(observed: number, unobserved: number): number {
  return unobserved > 0 ? observed / (observed + unobserved) : 1;
}

function hasPublishableCoverage(row: AggRow, unobserved: UnobservedValue | undefined): boolean {
  if (unobserved == null) return true;
  return observedShare(row.total, unobserved.total) >= MIN_PUBLISHED_TOTAL_COVERAGE
    && observedShare(row.commodity, unobserved.commodity) >= MIN_PUBLISHED_COHORT_COVERAGE
    && observedShare(row.fiat_non_usd, unobserved.fiatNonUsd) >= MIN_PUBLISHED_COHORT_COVERAGE;
}

export const handleNonUsdShare = async (db: D1Database, url: URL): Promise<Response> => {
    const params = parseQueryParams(url.searchParams, {
      days: {
        type: "int",
        default: DEFAULT_DAYS,
        min: MIN_DAYS,
        max: MAX_DAYS,
        rangePolicy: "reject",
      },
    });
    if (params instanceof Response) return params;
    const { days } = params;
    const cutoff = Math.floor(Date.now() / 1000) - days * DAY_SECONDS;

    const completedSnapshot = await getCompletedSupplySnapshot(db);
    const latestSnapshotFilter = completedSnapshot == null ? "" : " AND snapshot_date <= ?";
    const latestSnapshotBinds = completedSnapshot == null ? [] : [completedSnapshot.snapshotDate];

    const [rows, gaps] = await Promise.all([
      readRows(db, cutoff, latestSnapshotFilter, latestSnapshotBinds),
      readCoinHistoryGaps(db, cutoff, latestSnapshotFilter, latestSnapshotBinds),
    ]);
    const unobservedByDate = sumUnobservedValueByDate(rows, gaps);

    // Downsample: daily for last 90d, weekly for last 2y, monthly beyond
    const nowSec = Math.floor(Date.now() / 1000);
    const ninetyDaysAgo = nowSec - 90 * DAY_SECONDS;
    const twoYearsAgo = nowSec - 2 * 365 * DAY_SECONDS;

    const points: NonUsdSharePoint[] = [];
    let lastKeptDate = 0;

    for (const row of rows) {
      if (row.total <= 0 || !hasPublishableCoverage(row, unobservedByDate.get(row.snapshot_date))) continue;

      let interval: number;
      if (row.snapshot_date >= ninetyDaysAgo) {
        interval = DAY_SECONDS; // daily
      } else if (row.snapshot_date >= twoYearsAgo) {
        interval = 7 * DAY_SECONDS; // weekly
      } else {
        interval = 30 * DAY_SECONDS; // monthly
      }

      if (row.snapshot_date - lastKeptDate >= interval) {
        points.push({
          date: row.snapshot_date,
          commodityShare: Math.round((row.commodity / row.total) * 100 * 10000) / 10000,
          fiatNonUsdShare: Math.round((row.fiat_non_usd / row.total) * 100 * 10000) / 10000,
          commodity: row.commodity,
          fiatNonUsd: row.fiat_non_usd,
          total: row.total,
        });
        lastKeptDate = row.snapshot_date;
      }
    }
    const validated = NonUsdShareResponseSchema.safeParse(points);
    if (!validated.success) {
      return errorResponse(503, "Non-USD share data is unavailable", { noStore: true });
    }

    const latestPointDate = points.reduce<number | null>(
      (latest, point) => (latest == null ? point.date : Math.max(latest, point.date)),
      null,
    );
    const updatedAt = completedSnapshot?.updatedAt ?? latestPointDate;
    const headers =
      updatedAt == null
        ? { "Cache-Control": CACHE_PROFILES.slow }
        : addFreshnessHeaders(
            { "Cache-Control": CACHE_PROFILES.slow },
            updatedAt,
            API_FRESHNESS_MAX_AGE_SEC.nonUsdShare,
          );

    return jsonResponseWithHeaders(points, headers);
  };
