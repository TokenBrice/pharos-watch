import { WORKER_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
  filterCoreAggregateStablecoins,
} from "@shared/lib/stablecoins/aggregate-universe";
import {
  CORE_AGGREGATE_V1_MEMBER_IDS,
  CORE_AGGREGATE_V1_MEMBER_LIST,
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS,
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST,
  getCoreAggregatePostCutoverEntrySec,
  getCoreAggregatePostCutoverExitSec,
} from "@shared/lib/stablecoins/aggregate-universe-v1";
import { isActiveStablecoinMeta, isFrozenStablecoinMeta } from "@shared/lib/stablecoins/status";
import { isCommodityPeg } from "@shared/lib/filter-tags";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { NonUsdShareResponseSchema, type NonUsdSharePoint } from "@shared/types/supply";
import { getCaches } from "./db-cache";
import { getCompletedSupplySnapshot, SNAPSHOT_SUPPLY_LAST_WRITE_KEY } from "./supply-snapshot-completion";
import { throwIfAborted } from "./abort";
import { parseJson } from "./json-parse";
import { isRecord } from "@shared/lib/type-guards";
import { sampleHistoricalDatePoints } from "./stablecoin-charts-payload";
import { NON_USD_SHARE_MAX_DAYS } from "@shared/lib/api-endpoints/queries";

export const NON_USD_SHARE_HISTORY_KEY = "non-usd-share:daily:v1";

export interface NonUsdShareMemberRule {
  bucket: "usd" | "commodity" | "fiat-non-usd";
  /** Inclusive UTC-day lower bound (unix seconds); omitted when active before v2 cutover. */
  activeFrom?: number;
  /** Exclusive UTC-day upper bound (unix seconds); null when active through the present. */
  inactiveFrom: number | null;
}

export type NonUsdShareCoinMeta = Pick<StablecoinMeta, "id" | "status" | "frozenAt"> & {
  flags: Pick<StablecoinMeta["flags"], "pegCurrency">;
};

/**
 * Build date-fenced core membership for `/api/non-usd-share`:
 * - Dates strictly before `cutoverSec` use the frozen listing-policy v1 membership.
 * - Dates at or after `cutoverSec` use the current listing-policy v2 membership,
 *   except reviewed post-cutover listing-class exits in `CORE_AGGREGATE_V2_POST_CUTOVER_EXIT_DATES`.
 * Frozen rows contribute only before their recorded lifecycle cutoff.
 */
export function buildNonUsdShareCoreMembers(options: {
  coins?: readonly NonUsdShareCoinMeta[];
  v1ActiveIds?: ReadonlySet<string>;
  v1NonActiveIds?: ReadonlySet<string>;
  currentCoreIds?: ReadonlySet<string>;
  cutoverSec?: number;
} = {}): Map<string, NonUsdShareMemberRule> {
  const coins: readonly NonUsdShareCoinMeta[] =
    options.coins ?? WORKER_TRACKED_STABLECOINS;
  const v1ActiveIds = options.v1ActiveIds ?? CORE_AGGREGATE_V1_MEMBER_IDS;
  const v1NonActiveIds = options.v1NonActiveIds ?? CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS;
  const currentCoreIds = options.currentCoreIds
    ?? new Set(filterCoreAggregateStablecoins(coins).map((coin) => coin.id));
  const cutoverSec = options.cutoverSec ?? CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC;

  const members = new Map<string, NonUsdShareMemberRule>();
  for (const coin of coins) {
    const rawFrozen = isFrozenStablecoinMeta(coin) && coin.frozenAt != null
      ? Date.parse(coin.frozenAt) / 1000
      : null;
    const frozenFrom = rawFrozen != null && Number.isFinite(rawFrozen) ? rawFrozen : null;

    const inV1Active = v1ActiveIds.has(coin.id);
    const inV1Frozen = !inV1Active && v1NonActiveIds.has(coin.id) && frozenFrom != null;
    const inV1 = inV1Active || inV1Frozen;
    // Members active at the v1 snapshot commit stay in v1 history until the cutover
    // (or their reviewed post-cutover listing-class exit date) regardless of any
    // backdated post-snapshot frozenAt (no restatement of published history).
    const postCutoverExitSec = getCoreAggregatePostCutoverExitSec(coin.id);
    const v1InactiveFrom = inV1Active
      ? (postCutoverExitSec != null && postCutoverExitSec > cutoverSec
          ? (frozenFrom != null && frozenFrom > cutoverSec ? Math.min(frozenFrom, postCutoverExitSec) : postCutoverExitSec)
          : cutoverSec)
      : inV1Frozen
        ? Math.min(frozenFrom!, cutoverSec)
        : null;

    const isEligibleCurrent = isActiveStablecoinMeta(coin) || (frozenFrom != null && frozenFrom > cutoverSec);
    const inV2 = currentCoreIds.has(coin.id) && isEligibleCurrent;
    const v2InactiveFrom = isActiveStablecoinMeta(coin) ? null : frozenFrom;

    if (!inV1 && !inV2) continue;

    const pegCurrency = coin.flags.pegCurrency;
    const bucket: NonUsdShareMemberRule["bucket"] = isCommodityPeg(pegCurrency)
      ? "commodity"
      : pegCurrency === "USD" ? "usd" : "fiat-non-usd";

    if (inV1 && inV2) {
      members.set(coin.id, { bucket, inactiveFrom: v2InactiveFrom });
    } else if (inV1) {
      members.set(coin.id, { bucket, inactiveFrom: v1InactiveFrom });
    } else {
      const postCutoverEntrySec = getCoreAggregatePostCutoverEntrySec(coin.id);
      const activeFrom = postCutoverEntrySec != null && postCutoverEntrySec > cutoverSec
        ? postCutoverEntrySec
        : cutoverSec;
      members.set(coin.id, { bucket, activeFrom, inactiveFrom: v2InactiveFrom });
    }
  }
  return members;
}

const CORE_MEMBERS = buildNonUsdShareCoreMembers();
const CORE_MEMBERS_JSON = JSON.stringify(Object.fromEntries(CORE_MEMBERS));

/** Cohort identity reflects both frozen v1 and current v2 memberships plus the cutover boundary. */
export const NON_USD_SHARE_COHORT_IDENTITY = JSON.stringify({
  universe: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  cutoverDate: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  v1Universe: CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  v1MemberIds: CORE_AGGREGATE_V1_MEMBER_LIST,
  v1NonActiveMemberIds: CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST,
  members: Object.fromEntries(CORE_MEMBERS),
});
const COHORT_IDENTITY = NON_USD_SHARE_COHORT_IDENTITY;

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
  membersJson: string,
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): D1PreparedStatement {
  return db.prepare(
      `WITH core_members AS (
         SELECT
           key AS id,
           value ->> '$.bucket' AS bucket,
           value ->> '$.activeFrom' AS active_from,
           value ->> '$.inactiveFrom' AS inactive_from
         FROM json_each(?)
       )
       SELECT
         snapshot_date,
         ROUND(SUM(circulating_usd), 2) AS total,
         ROUND(SUM(CASE WHEN bucket = 'commodity' THEN circulating_usd ELSE 0 END), 2) AS commodity,
         ROUND(SUM(CASE WHEN bucket = 'fiat-non-usd' THEN circulating_usd ELSE 0 END), 2) AS fiat_non_usd
       FROM supply_history
       JOIN core_members ON stablecoin_id = core_members.id
       WHERE snapshot_date >= ?${latestSnapshotFilter}
         AND (active_from IS NULL OR snapshot_date >= active_from)
         AND (inactive_from IS NULL OR snapshot_date < inactive_from)
       GROUP BY snapshot_date
       ORDER BY snapshot_date ASC`,
    )
    .bind(membersJson, cutoff, ...latestSnapshotBinds);
}

/** Per-coin gaps: consecutive rows of one asset more than a day apart, and each
 * asset's last row, which leaves a trailing gap until it is observed again. */
function prepareCoinHistoryGaps(
  db: D1Database,
  membersJson: string,
  cutoff: number,
  latestSnapshotFilter: string,
  latestSnapshotBinds: readonly unknown[],
): D1PreparedStatement {
  return db.prepare(
      `WITH
         core_members AS (
           SELECT
             key AS id,
             value ->> '$.activeFrom' AS active_from,
             value ->> '$.inactiveFrom' AS inactive_from
           FROM json_each(?)
         ),
         bounded_history AS (
           SELECT stablecoin_id, snapshot_date, circulating_usd
           FROM supply_history
           JOIN core_members ON stablecoin_id = core_members.id
           WHERE snapshot_date >= ?${latestSnapshotFilter}
             AND (active_from IS NULL OR snapshot_date >= active_from)
             AND (inactive_from IS NULL OR snapshot_date < inactive_from)
           UNION ALL
           SELECT history.stablecoin_id, history.snapshot_date, history.circulating_usd
           FROM core_members
           JOIN supply_history history ON history.stablecoin_id = core_members.id
             AND history.snapshot_date = (
               SELECT MAX(snapshot_date) FROM supply_history
               WHERE stablecoin_id = core_members.id AND snapshot_date < ?${latestSnapshotFilter}
                 AND (active_from IS NULL OR snapshot_date >= active_from)
                 AND (inactive_from IS NULL OR snapshot_date < inactive_from)
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
    .bind(membersJson, cutoff, ...latestSnapshotBinds, cutoff, ...latestSnapshotBinds, cutoff);
}

/**
 * Value of assets missing on each published date although observed before it,
 * whether or not a later row exists yet. `rows` must be sorted by
 * `snapshot_date` ascending.
 */
function sumUnobservedValueByDate(
  rows: readonly AggRow[],
  gaps: readonly CoinHistoryGapRow[],
  members: ReadonlyMap<string, NonUsdShareMemberRule> = CORE_MEMBERS,
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
    const member = members.get(gap.stablecoin_id);
    const nextDate = Math.min(gap.next_date ?? Number.POSITIVE_INFINITY, member?.inactiveFrom ?? Number.POSITIVE_INFINITY);
    for (let index = low; index < rows.length && rows[index]!.snapshot_date < nextDate; index++) {
      const date = rows[index]!.snapshot_date;
      const unobserved = unobservedByDate.get(date) ?? { total: 0, commodity: 0, fiatNonUsd: 0 };
      unobserved.total += gap.previous_usd;
      if (member?.bucket === "commodity") unobserved.commodity += gap.previous_usd;
      else if (member?.bucket === "fiat-non-usd") unobserved.fiatNonUsd += gap.previous_usd;
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
  members: ReadonlyMap<string, NonUsdShareMemberRule> = CORE_MEMBERS,
): Promise<ComputedNonUsdShareHistory> {
    const membersJson = members === CORE_MEMBERS
      ? CORE_MEMBERS_JSON
      : JSON.stringify(Object.fromEntries(members));
    const completedSnapshot = await getCompletedSupplySnapshot(db);
    const latestSnapshotFilter = completedSnapshot == null ? "" : " AND snapshot_date <= ?";
    const latestSnapshotBinds = completedSnapshot == null ? [] : [completedSnapshot.snapshotDate];
    const [markerResult, rowsResult, gapsResult] = await db.batch<AggRow | CoinHistoryGapRow | { value: string; updated_at: number }>([
      db.prepare("SELECT value, updated_at FROM cache WHERE key = ?").bind(SNAPSHOT_SUPPLY_LAST_WRITE_KEY),
      prepareRows(db, membersJson, cutoff, latestSnapshotFilter, latestSnapshotBinds),
      prepareCoinHistoryGaps(db, membersJson, cutoff, latestSnapshotFilter, latestSnapshotBinds),
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
    const unobservedByDate = sumUnobservedValueByDate(rows, gaps, members);


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
  return sampleHistoricalDatePoints(points.filter((point) => !(point.date < cutoff)), nowSec);
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
  | { status: "cohort-mismatch"; points: null; updatedAt: null }
  | { status: "invalid"; points: null; updatedAt: null }
> {
  const caches = await getCaches(db, [NON_USD_SHARE_HISTORY_KEY, SNAPSHOT_SUPPLY_LAST_WRITE_KEY]);
  const cached = caches.get(NON_USD_SHARE_HISTORY_KEY);
  const marker = caches.get(SNAPSHOT_SUPPLY_LAST_WRITE_KEY);
  if (!cached) return { status: "missing", points: null, updatedAt: null };
  if (!marker || cached.updatedAt !== marker.updatedAt) return { status: "invalid", points: null, updatedAt: null };
  const parsed = parseJson(cached.value);
  if (!parsed.ok || !isRecord(parsed.value) || parsed.value.sourceMarker !== marker.value
    || typeof parsed.value.cohortIdentity !== "string" || parsed.value.cohortIdentity.trim().length === 0) {
    return { status: "invalid", points: null, updatedAt: null };
  }
  const points = NonUsdShareResponseSchema.safeParse(parsed.value.points);
  if (!points.success) return { status: "invalid", points: null, updatedAt: null };
  if (parsed.value.cohortIdentity !== COHORT_IDENTITY) {
    return { status: "cohort-mismatch", points: null, updatedAt: null };
  }
  return { status: "ok", points: points.data, updatedAt: cached.updatedAt };
}
