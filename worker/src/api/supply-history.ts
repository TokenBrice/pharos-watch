import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { handleStablecoinHistoryRequest } from "../lib/api-history";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { getCompletedSupplySnapshot, type CompletedSupplySnapshot } from "../lib/supply-snapshot-completion";
import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "@shared/lib/api-query-history";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";
import { logWorkerEventArgs } from "../lib/structured-log";
import { parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";

interface SupplyHistoryRow {
  snapshot_date: number;
  circulating_usd: number;
  price: number | null;
  /** Migration 0287; NULL = coverage unrecorded (legacy, prior Worker, backfill). */
  supply_provenance?: string | null;
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
    fetchRows: async ({ db: database, stablecoinId, cutoff, range }) => {
      const completedSnapshot = await loadCompletedSnapshot();
      const latestSnapshotFilter = completedSnapshot == null ? "" : " AND snapshot_date <= ?";
      const latestSnapshotBinds = completedSnapshot == null ? [] : [completedSnapshot.snapshotDate];
      const lowerFilter = range === "all" ? "" : " AND snapshot_date >= ?";
      const lowerBinds = range === "all" ? [] : [cutoff];
      const result = await database
        .prepare(
          `SELECT snapshot_date, circulating_usd, price, supply_provenance
           FROM supply_history
           WHERE stablecoin_id = ?${lowerFilter}${latestSnapshotFilter}
           ORDER BY snapshot_date ASC`
        )
        .bind(stablecoinId, ...lowerBinds, ...latestSnapshotBinds)
        .all<SupplyHistoryRow>();
      return result.results ?? [];
    },
    mapRow: (row) => {
      // Malformed metadata degrades only this row's provenance to unknown; supply and price stay intact.
      const { provenance, invalid } = parseSupplyObservationProvenance(row.supply_provenance);
      if (invalid) {
        logWorkerEventArgs("handler", "warn",
          `[supply-history] supply-provenance-invalid for snapshot_date=${row.snapshot_date}; publishing unknown coverage`);
      }
      return {
        date: row.snapshot_date,
        circulatingUsd: row.circulating_usd,
        price: row.price,
        supplyProvenance: provenance,
      };
    },
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
