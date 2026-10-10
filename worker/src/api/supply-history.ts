import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { handleStablecoinHistoryRequest } from "../lib/api-history";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { getCompletedSupplySnapshot, type CompletedSupplySnapshot } from "../lib/supply-snapshot-completion";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";

interface SupplyHistoryRow {
  snapshot_date: number;
  circulating_usd: number;
  price: number | null;
}

function latestServedSupplyTimestamp(rows: SupplyHistoryRow[]): number | null {
  return rows.reduce<number | null>(
    (latest, row) => latest == null ? row.snapshot_date : Math.max(latest, row.snapshot_date),
    null,
  );
}
export const handleSupplyHistory = async (
  db: D1Database,
  url: URL,
  completedSnapshot?: CompletedSupplySnapshot | null,
): Promise<Response> => {
  let completedSnapshotPromise: ReturnType<typeof getCompletedSupplySnapshot> | null = null;
  const loadCompletedSnapshot = () => {
    completedSnapshotPromise ??= completedSnapshot === undefined
      ? getCompletedSupplySnapshot(db)
      : Promise.resolve(completedSnapshot);
    return completedSnapshotPromise;
  };

  return handleStablecoinHistoryRequest(db, url, {
    query: STABLECOIN_HISTORY_QUERY_CONTRACTS.supply,
    cacheControl: CACHE_PROFILES.slow,
    fetchRows: async ({ db: database, stablecoinId, cutoff }) => {
      const completedSnapshot = await loadCompletedSnapshot();
      const latestSnapshotFilter = completedSnapshot == null ? "" : " AND snapshot_date <= ?";
      const latestSnapshotBinds = completedSnapshot == null ? [] : [completedSnapshot.snapshotDate];
      const result = await database
        .prepare(
          `SELECT snapshot_date, circulating_usd, price
           FROM supply_history
           WHERE stablecoin_id = ? AND snapshot_date >= ?${latestSnapshotFilter}
           ORDER BY snapshot_date ASC`
        )
        .bind(stablecoinId, cutoff, ...latestSnapshotBinds)
        .all<SupplyHistoryRow>();
      return result.results ?? [];
    },
    mapRow: (row) => ({
      date: row.snapshot_date,
      circulatingUsd: row.circulating_usd,
      price: row.price,
    }),
    freshness: async ({ rows }) => {
      const completedSnapshot = await loadCompletedSnapshot();
      const updatedAt = completedSnapshot?.updatedAt ?? latestServedSupplyTimestamp(rows);
      return updatedAt == null || assessFreshnessTimestamp(Math.floor(Date.now() / 1000), updatedAt).reason != null
        ? null
        : {
          updatedAt,
          maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.supplyHistory,
        };
    },
    buildHeaders: async ({ rows }): Promise<Record<string, string>> => {
      const completedSnapshot = await loadCompletedSnapshot();
      const updatedAt = completedSnapshot?.updatedAt ?? latestServedSupplyTimestamp(rows);
      const assessment = assessFreshnessTimestamp(Math.floor(Date.now() / 1000), updatedAt);
      return assessment.reason == null ? {} : {
        "Cache-Control": "no-store",
        "X-Data-Updated-At": "unknown",
        "X-Data-Age": "unavailable",
        "X-Data-Freshness": "unknown",
        "X-Data-Freshness-Reason": assessment.reason,
        Warning: '199 - "Supply history observation clock is unavailable"',
      };
    },
  });
};
