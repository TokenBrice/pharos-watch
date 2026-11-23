import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { handleStablecoinHistoryRequest } from "../lib/api-history";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { getCompletedSupplySnapshot, type CompletedSupplySnapshot } from "../lib/supply-snapshot-completion";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";
import { matchesCurrentSupplyPerimeter } from "../lib/supply-history-db";
import { latestServedSupplyTimestamp, mapSupplyHistoryRow, type SupplyHistoryRow } from "../lib/supply-history-rows";

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
    fetchRows: async ({ db: database, stablecoinId, cutoff, range }) => {
      const completedSnapshot = await loadCompletedSnapshot();
      const latestSnapshotFilter = completedSnapshot == null ? "" : " AND snapshot_date <= ?";
      const latestSnapshotBinds = completedSnapshot == null ? [] : [completedSnapshot.snapshotDate];
      const lowerFilter = range === "all" ? "" : " AND snapshot_date >= ?";
      const lowerBinds = range === "all" ? [] : [cutoff];
      const result = await database
        .prepare(
          `SELECT snapshot_date, circulating_usd, price, supply_provenance,
                  circulating_native, valuation_price_usd, valuation_observed_at_sec
           FROM supply_history
           WHERE stablecoin_id = ?${lowerFilter}${latestSnapshotFilter}
           ORDER BY snapshot_date ASC`
        )
        .bind(stablecoinId, ...lowerBinds, ...latestSnapshotBinds)
        .all<SupplyHistoryRow>();
      const rows = result.results ?? [];
      const now = Math.floor(Date.now() / 1000);
      return rows.filter((row) => matchesCurrentSupplyPerimeter(stablecoinId, row.snapshot_date, row.supply_provenance, now));
    },
    mapRow: mapSupplyHistoryRow,
    freshness: ({ rows }) => {
      const updatedAt = latestServedSupplyTimestamp(rows);
      return updatedAt == null || assessFreshnessTimestamp(Math.floor(Date.now() / 1000), updatedAt).reason != null
        ? null
        : {
          updatedAt,
          maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.supplyHistory,
        };
    },
    buildHeaders: ({ rows }): Record<string, string> => {
      const updatedAt = latestServedSupplyTimestamp(rows);
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
