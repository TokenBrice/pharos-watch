import { CORE_PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { PSI_HISTORICAL_IDS } from "@shared/lib/psi-historical-assets";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import { DAY_SECONDS } from "@shared/lib/time-constants";

/** Both the target-day and prior-week as-of lookups need their full margin. */
export function getHistoricalPsiSupplyWindow(startDay: number, endDay: number): { startSec: number; endSec: number } {
  return {
    startSec: Math.max(0, startDay - 7 * DAY_SECONDS - MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC),
    endSec: endDay,
  };
}

export interface SupplySnapshot {
  date: number;
  mcap: number;
  price?: number;
}

export type SupplySnapshotMap = Map<string, SupplySnapshot[]>;

export interface PsiHistoricalUniverse {
  totalMcapUsd: number;
  mcapById: Map<string, number>;
  eligibleUniverseCount: number;
  coveredUniverseCount: number;
  historicalAssetCoverageCount: number;
}

/**
 * As-of lookup: the newest snapshot on or before `targetDay`, within 14 days.
 * A later snapshot is never selected — a replayed PSI day must not read market
 * cap or price that was first observed after that day.
 */
export function findNearestSupplySnapshot(
  snapshots: SupplySnapshot[] | undefined,
  targetDay: number,
): SupplySnapshot | null {
  return findAsOfSnapshot(snapshots, targetDay, (s) => s.date, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC);
}

export function buildPsiHistoricalSupplySnapshotMap(
  rows: Array<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number; price?: number | null }>,
): SupplySnapshotMap {
  const supplyByCoin: SupplySnapshotMap = new Map();

  for (const row of rows) {
    if (!CORE_PSI_ELIGIBLE_IDS.has(row.stablecoin_id)) continue;
    if (!Number.isFinite(row.circulating_usd) || row.circulating_usd < 0) continue;
    const list = supplyByCoin.get(row.stablecoin_id) ?? [];
    list.push({
      date: row.snapshot_date,
      mcap: row.circulating_usd,
      ...(typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0 ? { price: row.price } : {}),
    });
    supplyByCoin.set(row.stablecoin_id, list);
  }

  for (const snapshots of supplyByCoin.values()) {
    snapshots.sort((a, b) => a.date - b.date);
  }

  return supplyByCoin;
}

function buildPsiHistoricalUniverseForDay(supplyByCoin: SupplySnapshotMap, day: number): PsiHistoricalUniverse {
  const mcapById = new Map<string, number>();
  let totalMcapUsd = 0;
  let coveredUniverseCount = 0;
  let historicalAssetCoverageCount = 0;

  for (const coinId of CORE_PSI_ELIGIBLE_IDS) {
    const nearest = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    if (!nearest) continue;

    coveredUniverseCount++;
    if (PSI_HISTORICAL_IDS.has(coinId)) {
      historicalAssetCoverageCount++;
    }
    totalMcapUsd += nearest.mcap;
    mcapById.set(coinId, nearest.mcap);
  }

  return {
    totalMcapUsd,
    mcapById,
    eligibleUniverseCount: CORE_PSI_ELIGIBLE_IDS.size,
    coveredUniverseCount,
    historicalAssetCoverageCount,
  };
}

/**
 * Per-batch memoization cache keyed by day. Create one per `supplyByCoin`
 * (i.e. one per backfill/replay batch) so the same day's universe is scanned
 * once instead of recomputed for every consumer (current day, 7-day-ago
 * lookup, DEWS stress breadth).
 */
export type PsiUniverseCache = Map<number, PsiHistoricalUniverse>;

export function getPsiHistoricalUniverseForDay(
  supplyByCoin: SupplySnapshotMap,
  day: number,
  cache?: PsiUniverseCache,
): PsiHistoricalUniverse {
  if (!cache) return buildPsiHistoricalUniverseForDay(supplyByCoin, day);
  const cached = cache.get(day);
  if (cached) return cached;
  const computed = buildPsiHistoricalUniverseForDay(supplyByCoin, day);
  cache.set(day, computed);
  return computed;
}
