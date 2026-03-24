import { PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { SHADOW_IDS } from "@shared/lib/shadow-stablecoins";
import { binarySearchNearest } from "./binary-search";
import { DAY_SECONDS } from "@shared/lib/time-constants";

const MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC = 14 * DAY_SECONDS;

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
  shadowCoverageCount: number;
}

export function findNearestSupplySnapshot(
  snapshots: SupplySnapshot[] | undefined,
  targetDay: number,
): SupplySnapshot | null {
  if (!snapshots || snapshots.length === 0) return null;
  const nearest = binarySearchNearest(snapshots, targetDay, (s) => s.date);
  if (!nearest) return null;
  return Math.abs(nearest.date - targetDay) <= MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC ? nearest : null;
}

export function buildPsiHistoricalSupplySnapshotMap(
  rows: Array<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number; price?: number | null }>,
): SupplySnapshotMap {
  const supplyByCoin: SupplySnapshotMap = new Map();

  for (const row of rows) {
    if (!PSI_ELIGIBLE_IDS.has(row.stablecoin_id)) continue;
    const list = supplyByCoin.get(row.stablecoin_id) ?? [];
    list.push({
      date: row.snapshot_date,
      mcap: row.circulating_usd,
      ...(typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0
        ? { price: row.price }
        : {}),
    });
    supplyByCoin.set(row.stablecoin_id, list);
  }

  for (const snapshots of supplyByCoin.values()) {
    snapshots.sort((a, b) => a.date - b.date);
  }

  return supplyByCoin;
}

export function buildPsiHistoricalUniverseForDay(
  supplyByCoin: SupplySnapshotMap,
  day: number,
): PsiHistoricalUniverse {
  const mcapById = new Map<string, number>();
  let totalMcapUsd = 0;
  let coveredUniverseCount = 0;
  let shadowCoverageCount = 0;

  for (const coinId of PSI_ELIGIBLE_IDS) {
    const nearest = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    if (!nearest) continue;

    coveredUniverseCount++;
    if (SHADOW_IDS.has(coinId)) {
      shadowCoverageCount++;
    }
    totalMcapUsd += nearest.mcap;
    mcapById.set(coinId, nearest.mcap);
  }

  return {
    totalMcapUsd,
    mcapById,
    eligibleUniverseCount: PSI_ELIGIBLE_IDS.size,
    coveredUniverseCount,
    shadowCoverageCount,
  };
}
