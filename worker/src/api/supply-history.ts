import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  handleStablecoinHistoryRequest,
  } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCompletedSupplySnapshot } from "../lib/supply-snapshot-completion";

interface SupplyHistoryRow {
  snapshot_date: number;
  circulating_usd: number;
  price: number | null;
}

const DEFAULT_SUPPLY_HISTORY_DAYS = 365;
const MAX_SUPPLY_HISTORY_DAYS = 5000;

export const handleSupplyHistory = async (
  db: D1Database,
  url: URL
): Promise<Response> => {
  let completedSnapshotPromise: ReturnType<typeof getCompletedSupplySnapshot> | null = null;
  const loadCompletedSnapshot = () => {
    completedSnapshotPromise ??= getCompletedSupplySnapshot(db);
    return completedSnapshotPromise;
  };

  return handleStablecoinHistoryRequest(db, url, {
    query: {
      defaultDays: DEFAULT_SUPPLY_HISTORY_DAYS,
      minDays: 1,
      maxDays: MAX_SUPPLY_HISTORY_DAYS,
      rangePolicy: "reject",
    },
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
      const latestRowTimestamp = rows.reduce<number | null>(
        (latest, row) => latest == null ? row.snapshot_date : Math.max(latest, row.snapshot_date),
        null,
      );
      const updatedAt = completedSnapshot?.updatedAt ?? latestRowTimestamp;
      return updatedAt == null
        ? null
        : {
          updatedAt,
          maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.supplyHistory,
        };
    },
  });
};
