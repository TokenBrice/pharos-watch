import { isDewsAlertBand } from "@shared/lib/classification";
import { computeStabilityIndex, DEWS_STRESS_BREADTH_SCALE, type StabilityInput, type StabilityResult } from "./stability-index";
import type { SupplySnapshotMap, PsiUniverseCache } from "./psi-history-universe";
import { getPsiHistoricalUniverseForDay } from "./psi-history-universe";
import { buildStabilityInputForDay, includePsiEventDeviation, type PsiDepegEventRow } from "./psi-recompute";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE } from "@shared/lib/stablecoins/aggregate-universe";
import { canonicalizePsiStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { getConditionBand } from "@shared/lib/psi-policy";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { round1, roundTo } from "@shared/lib/math";
import type { ReplayHistoricalReferenceLookup } from "./backfill-fx";

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

function usesHistoricalStressBreadth(methodologyVersion: string): boolean {
  return Number(methodologyVersion.split(".")[0]) >= 3;
}

export function computePsiStressBreadth(
  rows: readonly { stablecoin_id: string; band: string }[],
  mcapById: ReadonlyMap<string, number>,
  activeEventIds: ReadonlySet<string>,
): number {
  const stressed = new Set(rows.filter((row) => isDewsAlertBand(row.band))
    .map((row) => canonicalizePsiStablecoinId(row.stablecoin_id)));
  let breadth = 0;
  for (const id of stressed) {
    const mcap = mcapById.get(id);
    if (mcap != null && !activeEventIds.has(id)) breadth += Math.sqrt(mcap / 1e9) * DEWS_STRESS_BREADTH_SCALE;
  }
  return breadth;
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
  return computePsiStressBreadth(rows, universe.mcapById, new Set());
}

export interface HistoricalPsiReplayInput {
  day: number;
  now: number;
  methodologyVersion: string;
  depegEvents: PsiDepegEventRow[];
  supplyByCoin: SupplySnapshotMap;
  dewsByDay?: PsiHistoricalDewsMap;
  universeCache?: PsiUniverseCache;
  references?: ReplayHistoricalReferenceLookup;
  sampleSlots?: readonly number[];
}

export interface HistoricalPsiReplayResult {
  result: StabilityResult | null;
  sampleScores?: Record<number, number>;
  unavailableReason: "trend-inputs-unavailable" | "dews-archive-unavailable" | "insufficient-market-cap" |
    "open-depeg-inputs-unavailable" | null;
  input: Omit<StabilityInput, "mcap7dChangePct"> & {
    mcap7dChangePct: number | null;
    trendUnavailableIds: string[];
    nativeQuantityMomentum?: Record<string, number>;
    depegCount: number;
    eligibleUniverseCount: number;
    coveredUniverseCount: number;
    historicalAssetCoverageCount: number;
    historicalPriceCoverageCount: number;
    peakDeviationFallbackCount: number;
    openDepegsWithoutPrice: number;
    openDepegsWithoutWeight: number;
    dewsArchiveRowCount: number;
    dewsArchiveSnapshotDate: number | null;
    overlapBasis: "retained-sample-slots" | "utc-day-fraction";
    priceBasis: "sample-as-of" | "daily-interval-estimate";
    referenceMode: "dated-lookup" | "dated-lookup-unavailable";
  };
}

export function replayHistoricalPsiForDay(
  input: HistoricalPsiReplayInput,
): HistoricalPsiReplayResult {
  const slots = [...new Set(input.sampleSlots ?? [])]
    .filter((at) => at >= input.day && at < input.day + DAY_SECONDS && at <= input.now)
    .sort((a, b) => a - b);
  const baseInput = buildStabilityInputForDay(
    input.day,
    input.now,
    input.depegEvents,
    input.supplyByCoin,
    input.universeCache,
    input.references,
    slots,
  );
  const stressRequired = usesHistoricalStressBreadth(input.methodologyVersion);
  const dewsRows = input.dewsByDay?.get(input.day) ?? [];
  const dewsArchiveRowCount = dewsRows.length;
  const overlapBasis = slots.length > 0 ? "retained-sample-slots" : "utc-day-fraction";
  const stabilityInput = {
    depegs: baseInput.depegs,
    totalMcapUsd: baseInput.totalMcapUsd,
    mcap7dChangePct: baseInput.mcap7dChangePct,
  };
  let unavailableReason: HistoricalPsiReplayResult["unavailableReason"] = baseInput.mcap7dChangePct == null
    ? "trend-inputs-unavailable"
    : stressRequired && dewsArchiveRowCount === 0
      ? "dews-archive-unavailable"
      : !Number.isFinite(baseInput.totalMcapUsd) || baseInput.totalMcapUsd <= 0
        ? "insufficient-market-cap"
        : baseInput.openDepegsWithoutPrice > 0 || baseInput.openDepegsWithoutWeight > 0
          ? "open-depeg-inputs-unavailable" : null;

  let result: StabilityResult | null = null;
  let stressMean: number | undefined;
  const sampleScores: Record<number, number> = {};
  if (unavailableReason == null && stabilityInput.mcap7dChangePct != null) {
    const universe = getPsiHistoricalUniverseForDay(input.supplyByCoin, input.day, input.universeCache);
    const boundaries = [...new Set([input.day, input.day + DAY_SECONDS, ...baseInput.activity.flatMap(({ intervals }) =>
      intervals.flatMap(({ fromSec, toSec }) => [fromSec, toSec]))])].sort((left, right) => left - right);
    const slices = slots.length > 0
      ? slots.map((at) => ({ at, weight: 1 / slots.length }))
      : boundaries.slice(0, -1).map((at, index) => ({ at, weight: (boundaries[index + 1]! - at) / DAY_SECONDS }));
    const totals = { score: 0, severity: 0, breadth: 0, stressBreadth: 0, trend: 0, rawStressBreadth: 0 };
    for (const { at, weight } of slices) {
      const active = new Set<string>();
      const depegs = baseInput.activity.flatMap(({ id, mcapUsd, intervals }) => {
        const aggregate = { worstBps: 0, earliestStart: Infinity };
        for (const interval of intervals) {
          if (at >= interval.fromSec && at < interval.toSec) {
            includePsiEventDeviation(aggregate, interval.bps, interval.startedAt);
          }
        }
        if (aggregate.earliestStart === Infinity) return [];
        active.add(id);
        return [{ bps: aggregate.worstBps, mcapUsd, depegAgeDays: (at - aggregate.earliestStart) / DAY_SECONDS }];
      });
      const stress = stressRequired ? computePsiStressBreadth(dewsRows, universe.mcapById, active) : 0;
      const score = computeStabilityIndex({ ...stabilityInput, depegs, mcap7dChangePct: stabilityInput.mcap7dChangePct, dewsStressBreadth: stress });
      if (!score) {
        unavailableReason = "insufficient-market-cap";
        break;
      }
      if (slots.length > 0) sampleScores[at] = score.score;
      totals.score += weight * score.score;
      totals.severity += weight * score.components.severity;
      totals.breadth += weight * score.components.breadth;
      totals.stressBreadth += weight * score.components.stressBreadth;
      totals.trend += weight * score.components.trend;
      totals.rawStressBreadth += weight * stress;
    }
    if (unavailableReason == null) {
      const score = round1(totals.score);
      result = { score, band: getConditionBand(score), components: {
        severity: roundTo(totals.severity, 2), breadth: roundTo(totals.breadth, 2),
        stressBreadth: roundTo(totals.stressBreadth, 2), trend: roundTo(totals.trend, 2),
      } };
      if (stressRequired) stressMean = totals.rawStressBreadth;
    }
  }

  return {
    unavailableReason,
    result,
    ...(result != null && slots.length > 0 ? { sampleScores } : {}),
    input: {
      ...stabilityInput,
      ...(stressMean != null ? { dewsStressBreadth: stressMean } : {}),
      overlapBasis,
      priceBasis: slots.length > 0 ? "sample-as-of" : "daily-interval-estimate",
      referenceMode: input.references ? "dated-lookup" : "dated-lookup-unavailable",
      trendUnavailableIds: baseInput.trendUnavailableIds,
      ...(baseInput.nativeQuantityMomentum ? { nativeQuantityMomentum: baseInput.nativeQuantityMomentum } : {}),
      dewsArchiveRowCount,
      dewsArchiveSnapshotDate: dewsArchiveRowCount > 0 ? input.day : null,
      depegCount: baseInput.depegCount,
      eligibleUniverseCount: baseInput.eligibleUniverseCount,
      coveredUniverseCount: baseInput.coveredUniverseCount,
      historicalAssetCoverageCount: baseInput.historicalAssetCoverageCount,
      historicalPriceCoverageCount: baseInput.historicalPriceCoverageCount,
      peakDeviationFallbackCount: baseInput.peakDeviationFallbackCount,
      openDepegsWithoutPrice: baseInput.openDepegsWithoutPrice,
      openDepegsWithoutWeight: baseInput.openDepegsWithoutWeight,
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
    // Every replay drops reference-market artifacts (`applyReferenceMarketClosureRule`), so the
    // one-shot artifact repair must never subtract them from this row again.
    referenceMarketRule: true,
  };
}
