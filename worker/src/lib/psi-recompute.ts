import {
  buildPsiHistoricalSupplySnapshotMap,
  getPsiHistoricalUniverseForDay,
  findNearestSupplySnapshot,
  type SupplySnapshotMap,
  type PsiUniverseCache,
} from "./psi-history-universe";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { canonicalizePsiStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { CORE_PSI_ELIGIBLE_IDS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { deriveDepegSignal } from "./depeg-signals";

const HISTORICAL_PEAK_FLOOR_WINDOW_DAYS = 1;
const HISTORICAL_PEAK_FLOOR_MIN_CLOSE_PERSISTENCE_SEC = 6 * 3600;

export interface PsiDepegEventRow {
  stablecoin_id: string;
  peak_deviation_bps: number;
  peg_reference: number;
  started_at: number;
  ended_at: number | null;
}

export interface PsiSupplyRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
  price?: number | null;
}

export interface StabilityInputForDay {
  depegs: Array<{ bps: number; mcapUsd: number; depegAgeDays: number }>;
  totalMcapUsd: number;
  mcap7dChangePct: number;
  depegCount: number;
  eligibleUniverseCount: number;
  coveredUniverseCount: number;
  shadowCoverageCount: number;
  historicalPriceCoverageCount: number;
  peakDeviationFallbackCount: number;
}

export function buildSupplySnapshotMap(rows: PsiSupplyRow[]): SupplySnapshotMap {
  return buildPsiHistoricalSupplySnapshotMap(rows);
}

function computeHistoricalEventBps(
  event: PsiDepegEventRow,
  snapshotPrice: number | undefined,
  day: number,
  thresholdBps: number,
): { bps: number; source: "historical-price" | "peak-fallback" } | null {
  const peakDeviationBps = Number.isFinite(event.peak_deviation_bps) ? event.peak_deviation_bps : null;
  const historicalSignal = snapshotPrice != null ? deriveDepegSignal(snapshotPrice, event.peg_reference) : null;
  if (historicalSignal != null) {
    const historicalBps = historicalSignal.bps;
    const boundedHistoricalBps =
      peakDeviationBps != null && Math.abs(historicalBps) > Math.abs(peakDeviationBps)
        ? peakDeviationBps
        : historicalBps;
    const eventStartDay = Math.floor(event.started_at / DAY_SECONDS) * DAY_SECONDS;
    const dayEnd = day + DAY_SECONDS;
    const withinPeakFloorWindow = day - eventStartDay < HISTORICAL_PEAK_FLOOR_WINDOW_DAYS * DAY_SECONDS;
    const persistsMateriallyPastUtcClose =
      event.ended_at == null || event.ended_at >= dayEnd + HISTORICAL_PEAK_FLOOR_MIN_CLOSE_PERSISTENCE_SEC;
    const materiallyUnderstatesShock =
      peakDeviationBps != null && Math.abs(peakDeviationBps) - Math.abs(boundedHistoricalBps) >= thresholdBps;
    if (
      peakDeviationBps != null &&
      withinPeakFloorWindow &&
      persistsMateriallyPastUtcClose &&
      materiallyUnderstatesShock
    ) {
      return {
        bps: peakDeviationBps,
        source: "peak-fallback",
      };
    }

    // Only gate on threshold within the peak-floor window (start day) to drop
    // same-day wicks that recover before UTC close.  For multi-day events the
    // daily price is used regardless of threshold — matching the live cron,
    // which includes all active depegs without threshold filtering.
    if (withinPeakFloorWindow && Math.abs(boundedHistoricalBps) < thresholdBps) {
      return null;
    }

    return {
      bps: boundedHistoricalBps,
      source: boundedHistoricalBps === historicalBps ? "historical-price" : "peak-fallback",
    };
  }

  if (peakDeviationBps != null) {
    return {
      bps: peakDeviationBps,
      source: "peak-fallback",
    };
  }

  return null;
}

export function buildStabilityInputForDay(
  day: number,
  now: number,
  depegEvents: PsiDepegEventRow[],
  supplyByCoin: SupplySnapshotMap,
  universeCache?: PsiUniverseCache,
): StabilityInputForDay {
  const dayEnd = day + DAY_SECONDS;
  const activeDepegs = depegEvents.filter(
    (event) => event.started_at < dayEnd && (event.ended_at === null ? day <= now : event.ended_at > day),
  );

  const grouped = new Map<string, PsiDepegEventRow[]>();
  for (const event of activeDepegs) {
    const canonicalId = canonicalizePsiStablecoinId(event.stablecoin_id);
    const list = grouped.get(canonicalId) ?? [];
    list.push(event);
    grouped.set(canonicalId, list);
  }

  const depegs: Array<{ bps: number; mcapUsd: number; depegAgeDays: number }> = [];
  let historicalPriceCoverageCount = 0;
  let peakDeviationFallbackCount = 0;
  for (const [coinId, events] of grouped) {
    if (!CORE_PSI_ELIGIBLE_IDS.has(coinId)) continue;
    let worstBps = 0;
    let earliestStart = Infinity;
    let usedHistoricalPrice = false;
    let usedPeakFallback = false;
    const snapshot = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    const snapshotPrice = snapshot?.price;
    const thresholdBps =
      PSI_ELIGIBLE_META_BY_ID.get(coinId)?.flags.pegCurrency === "USD"
        ? DEPEG_THRESHOLD_BPS
        : DEPEG_THRESHOLD_BPS_NON_USD;

    for (const event of events) {
      const replayBps = computeHistoricalEventBps(event, snapshotPrice, day, thresholdBps);
      if (!replayBps) continue;
      if (Math.abs(replayBps.bps) > Math.abs(worstBps)) {
        worstBps = replayBps.bps;
      }
      if (replayBps.source === "historical-price") usedHistoricalPrice = true;
      if (replayBps.source === "peak-fallback") usedPeakFallback = true;
      if (event.started_at < earliestStart) {
        earliestStart = event.started_at;
      }
    }

    if (earliestStart === Infinity) continue;
    if (usedHistoricalPrice) historicalPriceCoverageCount++;
    if (usedPeakFallback) peakDeviationFallbackCount++;
    depegs.push({
      bps: worstBps,
      mcapUsd: snapshot?.mcap ?? 0,
      depegAgeDays: Math.max(0, (day - earliestStart) / DAY_SECONDS),
    });
  }

  const universe = getPsiHistoricalUniverseForDay(supplyByCoin, day, universeCache);
  const universe7dAgo = getPsiHistoricalUniverseForDay(supplyByCoin, day - 7 * DAY_SECONDS, universeCache);
  const totalMcapUsd = universe.totalMcapUsd;
  const totalMcap7dAgo = universe7dAgo.totalMcapUsd;
  const mcap7dChangePct = totalMcap7dAgo > 0 ? ((totalMcapUsd - totalMcap7dAgo) / totalMcap7dAgo) * 100 : 0;

  return {
    depegs,
    totalMcapUsd,
    mcap7dChangePct,
    depegCount: depegs.length,
    eligibleUniverseCount: universe.eligibleUniverseCount,
    coveredUniverseCount: universe.coveredUniverseCount,
    shadowCoverageCount: universe.shadowCoverageCount,
    historicalPriceCoverageCount,
    peakDeviationFallbackCount,
  };
}
