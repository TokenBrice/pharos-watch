import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { PegCurrency, YieldRanking, YieldType } from "@shared/types";

export type YieldPeerSafetyBand = "80-plus" | "70-79" | "60-69" | "50-59" | "under-50" | "unknown";

export type YieldPeerCohortKind = "same-peg" | "same-yield-type-safety" | "same-yield-type" | "all";

export type YieldPeerSelectionMode = "neighbors" | "top-fallback";
export type YieldPeerRelation = "above" | "below" | "top";

export interface YieldPeerRailItem {
  row: YieldRanking;
  rank: number;
  relation: YieldPeerRelation;
  peg: PegCurrency | null;
  safetyBand: YieldPeerSafetyBand;
}

export interface YieldPeerRailModel {
  items: YieldPeerRailItem[];
  cohortKind: YieldPeerCohortKind;
  selectionMode: YieldPeerSelectionMode;
  cohortSize: number;
  currentRank: number;
  currentPeg: PegCurrency | null;
  currentSafetyBand: YieldPeerSafetyBand;
  currentYieldType: YieldType;
}

export interface BuildYieldPeerRailModelOptions {
  rankings: readonly YieldRanking[];
  currentId: string;
  currentRow: YieldRanking;
  getPegForId?: (id: string) => PegCurrency | null;
}

interface IndexedRanking {
  row: YieldRanking;
  inputIndex: number;
  peg: PegCurrency | null;
  safetyBand: YieldPeerSafetyBand;
}

interface RankedPeer extends IndexedRanking {
  rank: number;
}

const NEIGHBOR_LIMIT = 3;
const TOP_FALLBACK_LIMIT = 3;

function defaultGetPegForId(id: string): PegCurrency | null {
  return TRACKED_META_BY_ID.get(id)?.flags.pegCurrency ?? null;
}

export function getYieldPeerSafetyBand(score: number | null | undefined): YieldPeerSafetyBand {
  if (score == null || !Number.isFinite(score)) return "unknown";
  if (score >= 80) return "80-plus";
  if (score >= 70) return "70-79";
  if (score >= 60) return "60-69";
  if (score >= 50) return "50-59";
  return "under-50";
}

function getOfficialRank(row: YieldRanking): number | null {
  const rank = row.liveRank ?? row.publishedRank ?? null;
  return rank != null && Number.isFinite(rank) && rank > 0 ? rank : null;
}

function hasSortablePosition(row: YieldRanking): boolean {
  return getOfficialRank(row) !== null || (row.pharosYieldScore != null && Number.isFinite(row.pharosYieldScore));
}

function compareByYieldRank(a: IndexedRanking, b: IndexedRanking): number {
  const rankA = getOfficialRank(a.row);
  const rankB = getOfficialRank(b.row);
  if (rankA !== null && rankB !== null && rankA !== rankB) return rankA - rankB;

  const scoreA = a.row.pharosYieldScore ?? Number.NEGATIVE_INFINITY;
  const scoreB = b.row.pharosYieldScore ?? Number.NEGATIVE_INFINITY;
  if (scoreA !== scoreB) return scoreB - scoreA;

  if (a.row.apy30d !== b.row.apy30d) return b.row.apy30d - a.row.apy30d;
  const symbolCompare = a.row.symbol.localeCompare(b.row.symbol);
  if (symbolCompare !== 0) return symbolCompare;
  return a.inputIndex - b.inputIndex;
}

function buildIndexedRows(
  rankings: readonly YieldRanking[],
  currentId: string,
  currentRow: YieldRanking,
  getPegForId: (id: string) => PegCurrency | null,
): IndexedRanking[] {
  const rowsById = new Map<string, YieldRanking>();
  for (const row of rankings) {
    if (!rowsById.has(row.id)) rowsById.set(row.id, row);
  }
  rowsById.set(currentId, currentRow);

  return Array.from(rowsById.values()).map((row, inputIndex) => ({
    row,
    inputIndex,
    peg: getPegForId(row.id),
    safetyBand: getYieldPeerSafetyBand(row.safetyScore),
  }));
}

function withGlobalRanks(rows: readonly IndexedRanking[]): RankedPeer[] {
  const sorted = [...rows].sort(compareByYieldRank);
  const fallbackRanks = new Map(sorted.map((entry, index) => [entry.row.id, index + 1] as const));
  return rows.map((entry) => ({
    ...entry,
    rank: getOfficialRank(entry.row) ?? fallbackRanks.get(entry.row.id) ?? entry.inputIndex + 1,
  }));
}

function hasPeer(cohort: readonly RankedPeer[], currentId: string): boolean {
  return cohort.some((entry) => entry.row.id !== currentId);
}

function selectCohort(
  rows: readonly RankedPeer[],
  current: RankedPeer,
): { kind: YieldPeerCohortKind; rows: RankedPeer[] } {
  if (current.peg) {
    const samePeg = rows.filter((entry) => entry.row.id === current.row.id || entry.peg === current.peg);
    if (hasPeer(samePeg, current.row.id)) {
      return { kind: "same-peg", rows: samePeg };
    }
  }

  const sameYieldTypeAndSafety = rows.filter(
    (entry) =>
      entry.row.id === current.row.id ||
      (entry.row.yieldType === current.row.yieldType && entry.safetyBand === current.safetyBand),
  );
  if (hasPeer(sameYieldTypeAndSafety, current.row.id)) {
    return { kind: "same-yield-type-safety", rows: sameYieldTypeAndSafety };
  }

  const sameYieldType = rows.filter(
    (entry) => entry.row.id === current.row.id || entry.row.yieldType === current.row.yieldType,
  );
  if (hasPeer(sameYieldType, current.row.id)) {
    return { kind: "same-yield-type", rows: sameYieldType };
  }

  return { kind: "all", rows: [...rows] };
}

function toItem(entry: RankedPeer, relation: YieldPeerRelation): YieldPeerRailItem {
  return {
    row: entry.row,
    rank: entry.rank,
    relation,
    peg: entry.peg,
    safetyBand: entry.safetyBand,
  };
}

export function buildYieldPeerRailModel({
  rankings,
  currentId,
  currentRow,
  getPegForId = defaultGetPegForId,
}: BuildYieldPeerRailModelOptions): YieldPeerRailModel | null {
  const indexedRows = buildIndexedRows(rankings, currentId, currentRow, getPegForId);
  const rankedRows = withGlobalRanks(indexedRows);
  const current = rankedRows.find((entry) => entry.row.id === currentId);
  if (!current) return null;

  const cohort = selectCohort(rankedRows, current);
  const sortedCohort = [...cohort.rows].sort(compareByYieldRank);
  const currentIndex = sortedCohort.findIndex((entry) => entry.row.id === currentId);
  const currentIsSortable = hasSortablePosition(current.row);

  if (currentIndex >= 0 && currentIsSortable) {
    const above = sortedCohort
      .slice(Math.max(0, currentIndex - NEIGHBOR_LIMIT), currentIndex)
      .map((entry) => toItem(entry, "above"));
    const below = sortedCohort
      .slice(currentIndex + 1, currentIndex + 1 + NEIGHBOR_LIMIT)
      .map((entry) => toItem(entry, "below"));
    const items = [...above, ...below];
    if (items.length > 0) {
      return {
        items,
        cohortKind: cohort.kind,
        selectionMode: "neighbors",
        cohortSize: sortedCohort.length,
        currentRank: current.rank,
        currentPeg: current.peg,
        currentSafetyBand: current.safetyBand,
        currentYieldType: current.row.yieldType,
      };
    }
  }

  const fallbackItems = sortedCohort
    .filter((entry) => entry.row.id !== currentId)
    .slice(0, TOP_FALLBACK_LIMIT)
    .map((entry) => toItem(entry, "top"));

  if (fallbackItems.length === 0) return null;

  return {
    items: fallbackItems,
    cohortKind: cohort.kind,
    selectionMode: "top-fallback",
    cohortSize: sortedCohort.length,
    currentRank: current.rank,
    currentPeg: current.peg,
    currentSafetyBand: current.safetyBand,
    currentYieldType: current.row.yieldType,
  };
}
