import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { filterCoreAggregateStablecoins } from "@shared/lib/stablecoins/aggregate-universe";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { NonUsdShareResponseSchema, type NonUsdSharePoint } from "@shared/types/market";
import { getCaches } from "./db-cache";
import { getCompletedSupplySnapshot, SNAPSHOT_SUPPLY_LAST_WRITE_KEY } from "./supply-snapshot-completion";
import { throwIfAborted } from "./abort";
import { parseJson } from "./json-parse";
import { isRecord } from "@shared/lib/type-guards";

export const NON_USD_SHARE_HISTORY_KEY = "non-usd-share:daily:v1";
export const NON_USD_SHARE_MAX_DAYS = 5000;

const CORE_AGGREGATE_ACTIVE_STABLECOINS = filterCoreAggregateStablecoins(WORKER_ACTIVE_STABLECOINS);

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
const COHORT_IDENTITY = JSON.stringify([CORE_IDS, COMMODITY_IDS, FIAT_NON_USD_IDS]);

// A day is published only when the core assets observed before it but missing
// on it (valued at their previous row) leave its total and each non-USD cohort
// mostly observed. That covers interior holes and trailing ones: the snapshot
// job writes a day without a non-systemic set of absent coins, so the latest
// days can lack an asset that has no later row yet. A partial day can also be a
// missed snapshot that later received per-coin backfill rows only; publishing it
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
  /** Next observation of the asset; null while it is still unobserved. */
  next_date: number | null;
  previous_usd: number;
}

interface UnobservedValue {
  total: number;
  commodity: number;
  fiatNonUsd: number;
}

function prepareRows(
  db: D1Database,
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): D1PreparedStatement {
  return db.prepare(
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
    );
}

/** Per-coin gaps: consecutive rows of one asset more than a day apart, and each
 * asset's last row, which leaves a trailing gap until it is observed again. */
function prepareCoinHistoryGaps(
  db: D1Database,
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): D1PreparedStatement {
  return db.prepare(
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
             circulating_usd,
             LEAD(snapshot_date) OVER by_coin AS next_date
           FROM bounded_history
           WINDOW by_coin AS (PARTITION BY stablecoin_id ORDER BY snapshot_date)
         )
       SELECT stablecoin_id, snapshot_date AS previous_date, next_date, circulating_usd AS previous_usd
       FROM coin_history
       WHERE next_date IS NULL OR (next_date >= ? AND next_date - snapshot_date > ${DAY_SECONDS})`,
    )
    .bind(JSON.stringify(CORE_IDS), cutoff, ...latestSnapshotBinds, cutoff, ...latestSnapshotBinds, cutoff);
}

/**
 * Value of assets missing on each published date although observed before it,
 * whether or not a later row exists yet. `rows` must be sorted by
 * `snapshot_date` ascending.
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
    const nextDate = gap.next_date ?? Number.POSITIVE_INFINITY;
    for (let index = low; index < rows.length && rows[index]!.snapshot_date < nextDate; index++) {
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

function pointCoverage(row: AggRow, unobserved: UnobservedValue | undefined): NonNullable<NonUsdSharePoint["coverage"]> {
  return {
    basis: "interior-gap-prior-value",
    total: observedShare(row.total, unobserved?.total ?? 0),
    commodity: observedShare(row.commodity, unobserved?.commodity ?? 0),
    fiatNonUsd: observedShare(row.fiat_non_usd, unobserved?.fiatNonUsd ?? 0),
  };
}

function hasPublishableCoverage(coverage: NonNullable<NonUsdSharePoint["coverage"]>): boolean {
  return coverage.total >= MIN_PUBLISHED_TOTAL_COVERAGE
    && coverage.commodity >= MIN_PUBLISHED_COHORT_COVERAGE
    && coverage.fiatNonUsd >= MIN_PUBLISHED_COHORT_COVERAGE;
}

export interface ComputedNonUsdShareHistory {
  points: NonUsdSharePoint[];
  updatedAt: number | null;
  snapshotUpdatedAt: number | null;
  sourceMarker: string | null;
}

/** Aggregation shared by the producer and absent-publication rollout fallback. */
export async function computeNonUsdShareHistory(
  db: D1Database,
  nowSec: number,
  cutoff = nowSec - NON_USD_SHARE_MAX_DAYS * DAY_SECONDS,
): Promise<ComputedNonUsdShareHistory> {
    const completedSnapshot = await getCompletedSupplySnapshot(db);
    const latestSnapshotFilter = completedSnapshot == null ? "" : " AND snapshot_date <= ?";
    const latestSnapshotBinds = completedSnapshot == null ? [] : [completedSnapshot.snapshotDate];
    const [markerResult, rowsResult, gapsResult] = await db.batch<AggRow | CoinHistoryGapRow | { value: string; updated_at: number }>([
      db.prepare("SELECT value, updated_at FROM cache WHERE key = ?").bind(SNAPSHOT_SUPPLY_LAST_WRITE_KEY),
      prepareRows(db, cutoff, latestSnapshotFilter, latestSnapshotBinds),
      prepareCoinHistoryGaps(db, cutoff, latestSnapshotFilter, latestSnapshotBinds),
    ]);
    const marker = (markerResult.results as Array<{ value: string; updated_at: number }>)[0];
    // A newer day must be retried from its own upper bound, not published under
    // the marker read before this transaction.
    const parsedMarker = marker ? parseJson(marker.value) : null;
    if (completedSnapshot && (!marker || marker.updated_at !== completedSnapshot.updatedAt
      || !parsedMarker?.ok || !isRecord(parsedMarker.value)
      || parsedMarker.value.snapshotDate !== completedSnapshot.snapshotDate)) {
      throw new Error("non-usd-share:source-generation-changed");
    }
    const rows = (rowsResult.results ?? []) as AggRow[];
    const gaps = (gapsResult.results ?? []) as CoinHistoryGapRow[];
    const unobservedByDate = sumUnobservedValueByDate(rows, gaps);


    const points: NonUsdSharePoint[] = [];

    for (const row of rows) {
      if (row.total <= 0) continue;
      const coverage = pointCoverage(row, unobservedByDate.get(row.snapshot_date));
      if (!hasPublishableCoverage(coverage)) continue;

        points.push({
          date: row.snapshot_date,
          commodityShare: Math.round((row.commodity / row.total) * 100 * 10000) / 10000,
          fiatNonUsdShare: Math.round((row.fiat_non_usd / row.total) * 100 * 10000) / 10000,
          commodity: row.commodity,
          fiatNonUsd: row.fiat_non_usd,
          total: row.total,
          coverage,
        });
    }
    const validated = NonUsdShareResponseSchema.safeParse(points);
    if (!validated.success) {
      throw new Error("non-usd-share:invalid-history");
    }

    const latestPointDate = points.reduce<number | null>(
      (latest, point) => (latest == null ? point.date : Math.max(latest, point.date)),
      null,
    );
    return {
      points: validated.data,
      updatedAt: completedSnapshot?.updatedAt ?? latestPointDate,
      snapshotUpdatedAt: completedSnapshot?.updatedAt ?? null,
      sourceMarker: marker?.value ?? null,
    };
}

/** Apply the existing window-relative sampling only after coverage admission. */
export function sampleNonUsdShareHistory(
  points: readonly NonUsdSharePoint[],
  cutoff: number,
  nowSec: number,
): NonUsdSharePoint[] {
  const sampled: NonUsdSharePoint[] = [];
  let lastKeptDate = 0;
  for (const point of points) {
    if (point.date < cutoff) continue;
    const interval = point.date >= nowSec - 90 * DAY_SECONDS
      ? DAY_SECONDS
      : point.date >= nowSec - 2 * 365 * DAY_SECONDS ? 7 * DAY_SECONDS : 30 * DAY_SECONDS;
    if (point.date - lastKeptDate >= interval) {
      sampled.push(point);
      lastKeptDate = point.date;
    }
  }
  return sampled;
}

export async function publishNonUsdShareHistory(db: D1Database, nowSec: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const completed = await getCompletedSupplySnapshot(db);
  if (!completed) throw new Error("non-usd-share:source-marker-unavailable");
  const existing = await readNonUsdShareHistory(db);
  if (existing.status === "ok" && existing.updatedAt === completed.updatedAt) return;
  const history = await computeNonUsdShareHistory(db, nowSec);
  throwIfAborted(signal);
  if (history.updatedAt == null || history.sourceMarker == null) {
    throw new Error("non-usd-share:source-marker-unavailable");
  }
  // The marker and both history queries were read in one transaction. A
  // concurrent same-day replacement must not publish mixed/old evidence.
  const result = await db.prepare(
    `INSERT INTO cache (key, value, updated_at)
     SELECT ?, ?, ? WHERE EXISTS (
       SELECT 1 FROM cache WHERE key = ? AND value = ? AND updated_at = ?
     )
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE cache.updated_at <= excluded.updated_at`,
  ).bind(
    NON_USD_SHARE_HISTORY_KEY, JSON.stringify({
      cohortIdentity: COHORT_IDENTITY, sourceMarker: history.sourceMarker, points: history.points,
    }), history.updatedAt,
    SNAPSHOT_SUPPLY_LAST_WRITE_KEY, history.sourceMarker, history.updatedAt,
  ).run();
  throwIfAborted(signal);
  if ((result.meta.changes ?? 0) === 0) throw new Error("non-usd-share:source-generation-changed");
}

export async function readNonUsdShareHistory(db: D1Database): Promise<
  | { status: "ok"; points: NonUsdSharePoint[]; updatedAt: number }
  | { status: "missing"; points: null; updatedAt: null }
  | { status: "invalid"; points: null; updatedAt: null }
> {
  const caches = await getCaches(db, [NON_USD_SHARE_HISTORY_KEY, SNAPSHOT_SUPPLY_LAST_WRITE_KEY]);
  const cached = caches.get(NON_USD_SHARE_HISTORY_KEY);
  const marker = caches.get(SNAPSHOT_SUPPLY_LAST_WRITE_KEY);
  if (!cached) return { status: "missing", points: null, updatedAt: null };
  if (!marker || cached.updatedAt !== marker.updatedAt) return { status: "invalid", points: null, updatedAt: null };
  const parsed = parseJson(cached.value);
  if (!parsed.ok || !isRecord(parsed.value) || parsed.value.sourceMarker !== marker.value
    || parsed.value.cohortIdentity !== COHORT_IDENTITY) return { status: "invalid", points: null, updatedAt: null };
  const points = NonUsdShareResponseSchema.safeParse(parsed.value.points);
  return points.success
    ? { status: "ok", points: points.data, updatedAt: cached.updatedAt }
    : { status: "invalid", points: null, updatedAt: null };
}
