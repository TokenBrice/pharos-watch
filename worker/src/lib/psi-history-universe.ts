import { CORE_PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { PSI_HISTORICAL_ASSETS, PSI_HISTORICAL_IDS } from "@shared/lib/psi-historical-assets";
import { filterCoreAggregateStablecoins } from "@shared/lib/stablecoins/aggregate-universe";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { fuzzyDateRange } from "@shared/lib/classification/resolve-implementation-launch-date";
import { classifySupplyCoverage, parseSupplyObservationProvenance, type SupplyCoverage } from "@shared/lib/supply-provenance";
import { isComparableNativeSupplySource } from "./dews/native-quantity";

const historicalMembership = new Map([...filterCoreAggregateStablecoins(TRACKED_STABLECOINS), ...PSI_HISTORICAL_ASSETS]
  .flatMap((coin) => {
    if (coin.status === "pre-launch") return [];
    const until = coin.frozenAt ?? (CORE_PSI_ELIGIBLE_IDS.has(coin.id) ? undefined : coin.listingStatusReview?.changedAt);
    if (!CORE_PSI_ELIGIBLE_IDS.has(coin.id) && until == null) return [];
    const launch = coin.launchDate == null ? null : fuzzyDateRange(coin.launchDate)?.start;
    return [[coin.id, {
      from: launch == null ? -Infinity : Date.parse(launch) / 1000,
      until: until == null ? Infinity : Date.parse(until) / 1000,
    }] as const];
  }));

/** Covers an extended reference closure and pending repricing with daily retained marks. */
export const PSI_HISTORICAL_REFERENCE_CARRY_MAX_AGE_SEC = 7 * DAY_SECONDS;

/** Cover the reference carry window and both market-cap lookups. */
export function getHistoricalPsiSupplyWindow(startDay: number, endDay: number): { startSec: number; endSec: number } {
  return {
    startSec: Math.max(0, startDay - Math.max(
      PSI_HISTORICAL_REFERENCE_CARRY_MAX_AGE_SEC,
      7 * DAY_SECONDS + MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC,
    )),
    endSec: endDay,
  };
}

export interface SupplySnapshot {
  date: number;
  mcap: number;
  price?: number;
  priceObservedAt?: number;
  coverage?: SupplyCoverage;
  nativeQuantity?: { value: number; observedAt: number };
}

export interface PsiSupplyRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
  price?: number | null;
  price_observed_at?: number | null;
  circulating_native?: number | null;
  supply_provenance?: string | null;
}

export type SupplySnapshotMap = Map<string, SupplySnapshot[]>;

export interface PsiHistoricalUniverse {
  totalMcapUsd: number;
  mcapById: Map<string, number>;
  eligibleIds: ReadonlySet<string>;
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
  rows: PsiSupplyRow[],
): SupplySnapshotMap {
  const supplyByCoin: SupplySnapshotMap = new Map();

  for (const row of rows) {
    if (!historicalMembership.has(row.stablecoin_id)) continue;
    if (!Number.isFinite(row.circulating_usd) || row.circulating_usd < 0) continue;
    const native = row.circulating_native;
    const { provenance } = parseSupplyObservationProvenance(row.supply_provenance);
    const coverage = classifySupplyCoverage(provenance);
    const observedAt = provenance?.supplyObservedAt;
    const nativeQuantity = native != null && Number.isFinite(native) && native >= 0 &&
      observedAt != null && observedAt > 0 && observedAt < row.snapshot_date + DAY_SECONDS &&
      coverage === "complete" && isComparableNativeSupplySource(row.stablecoin_id, provenance?.supplySource)
      ? { value: native, observedAt } : undefined;
    const list = supplyByCoin.get(row.stablecoin_id) ?? [];
    list.push({
      date: row.snapshot_date,
      mcap: row.circulating_usd,
      ...(coverage === "unknown" ? {} : { coverage }),
      ...(typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0 ? { price: row.price } : {}),
      ...(row.price_observed_at != null && Number.isSafeInteger(row.price_observed_at) && row.price_observed_at > 0
        ? { priceObservedAt: row.price_observed_at } : {}),
      ...(nativeQuantity ? { nativeQuantity } : {}),
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
  const eligibleIds = new Set<string>();
  let totalMcapUsd = 0;
  let coveredUniverseCount = 0;
  let historicalAssetCoverageCount = 0;

  for (const [coinId, { from, until }] of historicalMembership) {
    if (day < from || day >= until) continue;
    eligibleIds.add(coinId);
    const nearest = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    if (!nearest || nearest.date < from) continue;

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
    eligibleIds,
    eligibleUniverseCount: eligibleIds.size,
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
