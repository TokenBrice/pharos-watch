import {
  buildPsiHistoricalSupplySnapshotMap,
  buildPsiHistoricalUniverseForDay,
  findNearestSupplySnapshot,
  type SupplySnapshotMap,
} from "./psi-history-universe";
import { DAY_SECONDS } from "@shared/lib/time-constants";

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
): { bps: number; source: "historical-price" | "peak-fallback" } | null {
  if (snapshotPrice != null && event.peg_reference > 0) {
    return {
      bps: Math.round(((snapshotPrice / event.peg_reference) - 1) * 10_000),
      source: "historical-price",
    };
  }

  if (Number.isFinite(event.peak_deviation_bps)) {
    return {
      bps: event.peak_deviation_bps,
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
): StabilityInputForDay {
  const activeDepegs = depegEvents.filter(
    (event) => event.started_at <= day && (event.ended_at === null ? day <= now : event.ended_at > day),
  );

  const grouped = new Map<string, PsiDepegEventRow[]>();
  for (const event of activeDepegs) {
    const list = grouped.get(event.stablecoin_id) ?? [];
    list.push(event);
    grouped.set(event.stablecoin_id, list);
  }

  const depegs: Array<{ bps: number; mcapUsd: number; depegAgeDays: number }> = [];
  let historicalPriceCoverageCount = 0;
  let peakDeviationFallbackCount = 0;
  for (const [coinId, events] of grouped) {
    let worstBps = 0;
    let earliestStart = Infinity;
    let usedHistoricalPrice = false;
    let usedPeakFallback = false;
    const snapshot = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    const snapshotPrice = snapshot?.price;

    for (const event of events) {
      const replayBps = computeHistoricalEventBps(event, snapshotPrice);
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

  const universe = buildPsiHistoricalUniverseForDay(supplyByCoin, day);
  const universe7dAgo = buildPsiHistoricalUniverseForDay(supplyByCoin, day - 7 * DAY_SECONDS);
  const totalMcapUsd = universe.totalMcapUsd;
  const totalMcap7dAgo = universe7dAgo.totalMcapUsd;
  const mcap7dChangePct =
    totalMcap7dAgo > 0
      ? ((totalMcapUsd - totalMcap7dAgo) / totalMcap7dAgo) * 100
      : 0;

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
