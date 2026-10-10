import { isDewsAlertBand } from "@shared/lib/classification";
import { computeStabilityIndex, DEWS_STRESS_BREADTH_SCALE, type StabilityInput, type StabilityResult } from "./stability-index";
import type { SupplySnapshotMap, PsiUniverseCache } from "./psi-history-universe";
import { getPsiHistoricalUniverseForDay } from "./psi-history-universe";
import { buildStabilityInputForDay, type PsiDepegEventRow } from "./psi-recompute";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE } from "@shared/lib/stablecoins/aggregate-universe";

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
): number | null {
  const rows = dewsByDay.get(day);
  if (!rows?.length) return null;

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
  unavailableReason: "trend-inputs-unavailable" | "dews-archive-unavailable" | "insufficient-market-cap" | null;
  input: Omit<StabilityInput, "mcap7dChangePct"> & {
    mcap7dChangePct: number | null;
    trendUnavailableIds: string[];
    depegCount: number;
    eligibleUniverseCount: number;
    coveredUniverseCount: number;
    historicalAssetCoverageCount: number;
    historicalPriceCoverageCount: number;
    peakDeviationFallbackCount: number;
    openDepegsWithoutPrice: number;
    dewsArchiveRowCount: number;
    dewsArchiveSnapshotDate: number | null;
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
  const stressRequired = usesHistoricalStressBreadth(input.methodologyVersion);
  const dewsArchiveRowCount = input.dewsByDay?.get(input.day)?.length ?? 0;
  const dewsStressBreadth = stressRequired
    ? computeHistoricalDewsStressBreadth(
      input.day, input.supplyByCoin, input.dewsByDay ?? new Map(), input.universeCache,
    )
    : null;
  const stabilityInput = {
    depegs: baseInput.depegs,
    totalMcapUsd: baseInput.totalMcapUsd,
    mcap7dChangePct: baseInput.mcap7dChangePct,
    ...(dewsStressBreadth != null ? { dewsStressBreadth } : {}),
  };
  const unavailableReason = baseInput.mcap7dChangePct == null
    ? "trend-inputs-unavailable"
    : stressRequired && dewsStressBreadth == null
      ? "dews-archive-unavailable"
      : !Number.isFinite(baseInput.totalMcapUsd) || baseInput.totalMcapUsd <= 0
        ? "insufficient-market-cap"
        : null;

  return {
    unavailableReason,
    result: unavailableReason == null && stabilityInput.mcap7dChangePct != null
      ? computeStabilityIndex({ ...stabilityInput, mcap7dChangePct: stabilityInput.mcap7dChangePct })
      : null,
    input: {
      ...stabilityInput,
      trendUnavailableIds: baseInput.trendUnavailableIds,
      dewsArchiveRowCount,
      dewsArchiveSnapshotDate: dewsArchiveRowCount > 0 ? input.day : null,
      depegCount: baseInput.depegCount,
      eligibleUniverseCount: baseInput.eligibleUniverseCount,
      coveredUniverseCount: baseInput.coveredUniverseCount,
      historicalAssetCoverageCount: baseInput.historicalAssetCoverageCount,
      historicalPriceCoverageCount: baseInput.historicalPriceCoverageCount,
      peakDeviationFallbackCount: baseInput.peakDeviationFallbackCount,
      openDepegsWithoutPrice: baseInput.openDepegsWithoutPrice,
    },
  };
}

/** One persisted replay provenance shape for backfill and atomic audit repairs. */
export function historicalPsiInputSnapshot(replay: HistoricalPsiReplayResult, methodologyVersion: string) {
  const { depegs: _depegs, ...input } = replay.input;
  return {
    aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
    ...input,
    degradedComponents: input.openDepegsWithoutPrice > 0 ? ["open-depeg-no-price"] : [],
    stressBreadthIncluded: usesHistoricalStressBreadth(methodologyVersion),
    methodologyVersion,
  };
}
