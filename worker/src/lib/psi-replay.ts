import { isDewsAlertBand } from "@shared/lib/classification";
import { computeStabilityIndex, DEWS_STRESS_BREADTH_SCALE, type StabilityInput, type StabilityResult } from "./stability-index";
import type { SupplySnapshotMap, PsiUniverseCache } from "./psi-history-universe";
import { getPsiHistoricalUniverseForDay } from "./psi-history-universe";
import { buildStabilityInputForDay, type PsiDepegEventRow } from "./psi-recompute";

export interface PsiHistoricalDewsRow {
  stablecoin_id: string;
  snapshot_date: number;
  band: string;
}

export type PsiHistoricalDewsMap = Map<number, PsiHistoricalDewsRow[]>;

export function buildHistoricalDewsMap(rows: PsiHistoricalDewsRow[]): PsiHistoricalDewsMap {
  const byDay: PsiHistoricalDewsMap = new Map();
  for (const row of rows) {
    const list = byDay.get(row.snapshot_date) ?? [];
    list.push(row);
    byDay.set(row.snapshot_date, list);
  }
  return byDay;
}

export function usesHistoricalStressBreadth(methodologyVersion: string): boolean {
  return methodologyVersion.startsWith("3.");
}

export function computeHistoricalDewsStressBreadth(
  day: number,
  supplyByCoin: SupplySnapshotMap,
  dewsByDay: PsiHistoricalDewsMap,
  universeCache?: PsiUniverseCache,
): number {
  const rows = dewsByDay.get(day) ?? [];
  if (rows.length === 0) return 0;

  const universe = getPsiHistoricalUniverseForDay(supplyByCoin, day, universeCache);
  let stressBreadth = 0;

  for (const row of rows) {
    if (!isDewsAlertBand(row.band)) continue;
    const mcapUsd = universe.mcapById.get(row.stablecoin_id) ?? 0;
    stressBreadth += Math.sqrt(mcapUsd / 1e9) * DEWS_STRESS_BREADTH_SCALE;
  }

  return stressBreadth;
}

export interface HistoricalPsiReplayInput {
  day: number;
  now: number;
  methodologyVersion: string;
  depegEvents: PsiDepegEventRow[];
  supplyByCoin: SupplySnapshotMap;
  dewsByDay?: PsiHistoricalDewsMap;
  universeCache?: PsiUniverseCache;
}

export interface HistoricalPsiReplayResult {
  result: StabilityResult | null;
  input: StabilityInput & {
    depegCount: number;
    eligibleUniverseCount: number;
    coveredUniverseCount: number;
    shadowCoverageCount: number;
    historicalPriceCoverageCount: number;
    peakDeviationFallbackCount: number;
  };
}

export function replayHistoricalPsiForDay(
  input: HistoricalPsiReplayInput,
): HistoricalPsiReplayResult {
  const baseInput = buildStabilityInputForDay(
    input.day,
    input.now,
    input.depegEvents,
    input.supplyByCoin,
    input.universeCache,
  );
  const stabilityInput: StabilityInput = {
    depegs: baseInput.depegs,
    totalMcapUsd: baseInput.totalMcapUsd,
    mcap7dChangePct: baseInput.mcap7dChangePct,
    ...(usesHistoricalStressBreadth(input.methodologyVersion)
      ? {
        dewsStressBreadth: computeHistoricalDewsStressBreadth(
          input.day,
          input.supplyByCoin,
          input.dewsByDay ?? new Map(),
          input.universeCache,
        ),
      }
      : {}),
  };

  return {
    result: computeStabilityIndex(stabilityInput),
    input: {
      ...stabilityInput,
      depegCount: baseInput.depegCount,
      eligibleUniverseCount: baseInput.eligibleUniverseCount,
      coveredUniverseCount: baseInput.coveredUniverseCount,
      shadowCoverageCount: baseInput.shadowCoverageCount,
      historicalPriceCoverageCount: baseInput.historicalPriceCoverageCount,
      peakDeviationFallbackCount: baseInput.peakDeviationFallbackCount,
    },
  };
}
