import { CORE_PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { PSI_HISTORICAL_ASSETS, PSI_HISTORICAL_IDS } from "@shared/lib/psi-historical-assets";
import {
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
  filterCoreAggregateStablecoins,
} from "@shared/lib/stablecoins/aggregate-universe";
import {
  CORE_AGGREGATE_V1_MEMBER_IDS,
  CORE_AGGREGATE_V1_NON_ACTIVE_EXIT_DATES,
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS,
  getCoreAggregatePostCutoverExitSec,
} from "@shared/lib/stablecoins/aggregate-universe-v1";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { fuzzyDateRange } from "@shared/lib/classification/resolve-implementation-launch-date";
import { classifySupplyCoverage, parseSupplyObservationProvenance, type SupplyCoverage } from "@shared/lib/supply-provenance";
import { isComparableNativeSupplySource } from "./dews/native-quantity";

export interface PsiHistoricalMembershipEntry {
  launchFrom: number;
  windows: readonly { from: number; until: number }[];
}

/**
 * Date-fenced historical PSI membership:
 * - Days strictly before `cutoverSec` use the frozen listing-policy v1 core membership
 *   plus off-catalog PSI historical assets.
 * - Days from `cutoverSec` onward use the current listing-policy v2 core membership
 *   (except reviewed post-cutover listing-class exits in `CORE_AGGREGATE_V2_POST_CUTOVER_EXIT_DATES`)
 *   plus off-catalog PSI historical assets.
 */
export function buildPsiHistoricalMembership(options: {
  coins?: readonly Pick<StablecoinMeta, "id" | "status" | "frozenAt" | "launchDate" | "listingStatusReview">[];
  v1ActiveIds?: ReadonlySet<string>;
  v1NonActiveIds?: ReadonlySet<string>;
  currentCoreIds?: ReadonlySet<string>;
  currentCorePsiEligibleIds?: ReadonlySet<string>;
  cutoverSec?: number;
} = {}): Map<string, PsiHistoricalMembershipEntry> {
  const coins = options.coins ?? [...TRACKED_STABLECOINS, ...PSI_HISTORICAL_ASSETS];
  const v1ActiveIds = options.v1ActiveIds ?? CORE_AGGREGATE_V1_MEMBER_IDS;
  const v1NonActiveIds = options.v1NonActiveIds ?? CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS;
  const currentCoreIds = options.currentCoreIds
    ?? new Set(filterCoreAggregateStablecoins(TRACKED_STABLECOINS).map((coin) => coin.id));
  const currentCorePsiEligibleIds = options.currentCorePsiEligibleIds ?? CORE_PSI_ELIGIBLE_IDS;
  const cutoverSec = options.cutoverSec ?? CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC;

  const membership = new Map<string, PsiHistoricalMembershipEntry>();
  for (const coin of coins) {
    const isHistoricalShadow = PSI_HISTORICAL_IDS.has(coin.id);
    const launchStart = coin.launchDate == null ? null : fuzzyDateRange(coin.launchDate)?.start;
    const launchFrom = launchStart == null ? -Infinity : Date.parse(launchStart) / 1000;

    const windows: Array<{ from: number; until: number }> = [];

    // Pre-cutover v1 window (< cutoverSec). Members active at the v1 snapshot commit
    // stay in v1 history until the cutover (or their reviewed post-cutover exit date
    // when later reclassified out of core-stablecoin) so published history is never restated.
    if (isHistoricalShadow || v1ActiveIds.has(coin.id)) {
      const postCutoverExitSec = !isHistoricalShadow && !currentCoreIds.has(coin.id)
        ? getCoreAggregatePostCutoverExitSec(coin.id)
        : null;
      const rawFrozen = coin.frozenAt == null ? NaN : Date.parse(coin.frozenAt) / 1000;
      const v1Until = postCutoverExitSec != null && postCutoverExitSec > cutoverSec
        ? (Number.isFinite(rawFrozen) && rawFrozen > cutoverSec ? Math.min(rawFrozen, postCutoverExitSec) : postCutoverExitSec)
        : cutoverSec;
      if (launchFrom < v1Until) windows.push({ from: launchFrom, until: v1Until });
    } else if (v1NonActiveIds.has(coin.id)) {
      const rawUntil = CORE_AGGREGATE_V1_NON_ACTIVE_EXIT_DATES[coin.id]
        ?? coin.frozenAt
        ?? coin.listingStatusReview?.changedAt;
      const parsedUntil = rawUntil == null ? NaN : Date.parse(rawUntil) / 1000;
      if (Number.isFinite(parsedUntil)) {
        const v1Until = Math.min(parsedUntil, cutoverSec);
        if (launchFrom < v1Until) windows.push({ from: launchFrom, until: v1Until });
      }
    }

    // Post-cutover v2 window (>= cutoverSec)
    if (coin.status !== "pre-launch" && (isHistoricalShadow || currentCoreIds.has(coin.id))) {
      const isLiveEligible = isHistoricalShadow || currentCorePsiEligibleIds.has(coin.id);
      const rawUntil = coin.frozenAt ?? (isLiveEligible ? undefined : coin.listingStatusReview?.changedAt);
      if (isLiveEligible || rawUntil != null) {
        const parsedUntil = rawUntil == null ? Infinity : Date.parse(rawUntil) / 1000;
        const v2From = Math.max(launchFrom, cutoverSec);
        if (Number.isFinite(v2From) && v2From < parsedUntil) {
          const prev = windows[windows.length - 1];
          if (prev && prev.until === v2From) {
            prev.until = parsedUntil;
          } else {
            windows.push({ from: v2From, until: parsedUntil });
          }
        }
      }
    }

    if (windows.length > 0) {
      membership.set(coin.id, { launchFrom, windows });
    }
  }
  return membership;
}

const historicalMembership = buildPsiHistoricalMembership();

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
  membership: ReadonlyMap<string, PsiHistoricalMembershipEntry> = historicalMembership,
): SupplySnapshotMap {
  const supplyByCoin: SupplySnapshotMap = new Map();

  for (const row of rows) {
    if (!membership.has(row.stablecoin_id)) continue;
    if (!Number.isFinite(row.circulating_usd) || row.circulating_usd < 0) continue;
    const native = row.circulating_native;
    const { provenance } = parseSupplyObservationProvenance(row.supply_provenance);
    const coverage = classifySupplyCoverage(provenance);
    const observedAt = provenance?.supplyObservedAt;
    const nativeQuantity = !provenance?.nativeQuantityUnavailable && native != null && Number.isFinite(native) && native >= 0 &&
      observedAt != null && observedAt > 0 && observedAt < row.snapshot_date + DAY_SECONDS &&
      coverage === "complete" && isComparableNativeSupplySource(row.stablecoin_id, provenance?.supplySource)
      ? { value: native, observedAt } : undefined;
    const marketQuote = provenance?.marketQuote;
    const datedQuote = marketQuote?.observedAt != null && marketQuote.observedAt < row.snapshot_date + DAY_SECONDS
      ? marketQuote : undefined;
    const price = datedQuote?.price ?? row.price;
    const priceObservedAt = datedQuote?.observedAt ?? row.price_observed_at;
    const list = supplyByCoin.get(row.stablecoin_id) ?? [];
    list.push({
      date: row.snapshot_date,
      mcap: row.circulating_usd,
      ...(coverage === "unknown" ? {} : { coverage }),
      ...(typeof price === "number" && Number.isFinite(price) && price > 0 ? { price } : {}),
      ...(priceObservedAt != null && Number.isSafeInteger(priceObservedAt) && priceObservedAt > 0
        ? { priceObservedAt } : {}),
      ...(nativeQuantity ? { nativeQuantity } : {}),
    });
    supplyByCoin.set(row.stablecoin_id, list);
  }

  for (const snapshots of supplyByCoin.values()) {
    snapshots.sort((a, b) => a.date - b.date);
  }

  return supplyByCoin;
}

function buildPsiHistoricalUniverseForDay(
  supplyByCoin: SupplySnapshotMap,
  day: number,
  membership: ReadonlyMap<string, PsiHistoricalMembershipEntry> = historicalMembership,
): PsiHistoricalUniverse {
  const mcapById = new Map<string, number>();
  const eligibleIds = new Set<string>();
  let totalMcapUsd = 0;
  let coveredUniverseCount = 0;
  let historicalAssetCoverageCount = 0;

  for (const [coinId, { launchFrom, windows }] of membership) {
    if (!windows.some(({ from, until }) => day >= from && day < until)) continue;
    eligibleIds.add(coinId);
    const nearest = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    if (!nearest || nearest.date < launchFrom) continue;

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
  membership: ReadonlyMap<string, PsiHistoricalMembershipEntry> = historicalMembership,
): PsiHistoricalUniverse {
  if (!cache) return buildPsiHistoricalUniverseForDay(supplyByCoin, day, membership);
  const cached = cache.get(day);
  if (cached) return cached;
  const computed = buildPsiHistoricalUniverseForDay(supplyByCoin, day, membership);
  cache.set(day, computed);
  return computed;
}
