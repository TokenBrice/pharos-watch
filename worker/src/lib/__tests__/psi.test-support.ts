import { buildStabilityInputForDay, buildSupplySnapshotMap, type PsiDepegEventRow, type PsiSupplyRow } from "../psi-recompute";
import { replayHistoricalPsiForDay, type PsiHistoricalDewsMap } from "../psi-replay";

export const DAY = 86_400;

export function psiSupplyPair(input: { stablecoinId: string; day: number; currentMcap: number; priorMcap: number; currentPrice?: number | null; priorPrice?: number | null }): PsiSupplyRow[] {
  return [
    { stablecoin_id: input.stablecoinId, snapshot_date: input.day, circulating_usd: input.currentMcap, ...(input.currentPrice !== undefined ? { price: input.currentPrice } : {}) },
    { stablecoin_id: input.stablecoinId, snapshot_date: input.day - 7 * DAY, circulating_usd: input.priorMcap, ...(input.priorPrice !== undefined ? { price: input.priorPrice } : {}) },
  ];
}

export function psiDepegRow(input: { stablecoinId: string; day: number; startedOffsetSec: number; endedOffsetSec: number | null; peakDeviationBps: number; pegReference?: number }): PsiDepegEventRow {
  return {
    stablecoin_id: input.stablecoinId,
    peak_deviation_bps: input.peakDeviationBps,
    peg_reference: input.pegReference ?? 1,
    started_at: input.day + input.startedOffsetSec,
    ended_at: input.endedOffsetSec == null ? null : input.day + input.endedOffsetSec,
  };
}

export function buildPsiDayInput(input: { day: number; now?: number; supplyRows: PsiSupplyRow[]; depegEvents?: PsiDepegEventRow[] }) {
  return {
    day: input.day,
    now: input.now ?? input.day + DAY,
    supplyByCoin: buildSupplySnapshotMap(input.supplyRows),
    depegEvents: input.depegEvents ?? [],
  };
}

export function buildPsiStabilityInput(
  day: number,
  supplyRows: PsiSupplyRow[],
  depegEvents: PsiDepegEventRow[] = [],
  now?: number,
): ReturnType<typeof buildStabilityInputForDay> {
  const dayInput = buildPsiDayInput({ day, supplyRows, depegEvents, ...(now === undefined ? {} : { now }) });
  return buildStabilityInputForDay(dayInput.day, dayInput.now, dayInput.depegEvents, dayInput.supplyByCoin);
}

export function buildPsiReplayInput(input: { day: number; now?: number; methodologyVersion?: string; supplyRows: PsiSupplyRow[]; depegEvents?: PsiDepegEventRow[]; dewsByDay?: PsiHistoricalDewsMap }) {
  const dayInput = buildPsiDayInput(input);
  return { ...dayInput, methodologyVersion: input.methodologyVersion ?? "1.0", dewsByDay: input.dewsByDay ?? new Map() };
}

export function replayPsiDay(
  day: number,
  methodologyVersion: string,
  supplyRows: PsiSupplyRow[],
  depegEvents: PsiDepegEventRow[] = [],
  dewsByDay?: PsiHistoricalDewsMap,
  now?: number,
): ReturnType<typeof replayHistoricalPsiForDay> {
  return replayHistoricalPsiForDay(buildPsiReplayInput({ day, methodologyVersion, supplyRows, depegEvents, dewsByDay, ...(now === undefined ? {} : { now }) }));
}
