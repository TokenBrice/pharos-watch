import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { createTableComparator } from "@/lib/table-comparator";
import { compareDepegAttention, readTrackerDeviation, type DepegTrackerRow } from "@/lib/depeg-sort";

export type DepegTableSortKey =
  | "__attention"
  | "pegScore"
  | "dewsScore"
  | "currentDeviationBps"
  | "pegPct"
  | "eventCount"
  | "worstDeviationBps"
  | "activeDepeg"
  | "dexAgrees"
  | "trackingSpanDays";

type DepegFieldKey = Exclude<DepegTableSortKey, "__attention">;

function buildFieldExtractors(nowSec?: number): Record<DepegFieldKey, (r: DepegTrackerRow) => number | null> {
  return {
    pegScore: (r) => r.coin.pegScore,
    dewsScore: (r) => r.dews?.score ?? null,
    currentDeviationBps: (r) => {
      const { deviationBps } = readTrackerDeviation(r, nowSec);
      return deviationBps == null ? null : Math.abs(deviationBps);
    },
    pegPct: (r) => r.coin.pegPct,
    eventCount: (r) => r.coin.eventCount,
    worstDeviationBps: (r) => r.coin.worstDeviationBps == null ? null : Math.abs(r.coin.worstDeviationBps),
    activeDepeg: (r) => (r.coin.activeDepeg ? 1 : 0),
    dexAgrees: (r) => (r.coin.dexPriceCheck?.agrees ? 1 : 0),
    trackingSpanDays: (r) => r.coin.trackingSpanDays,
  };
}

const defaultFieldExtractors = buildFieldExtractors();
const compareByDefaultField = createTableComparator<DepegFieldKey, DepegTrackerRow>(defaultFieldExtractors);

export function compareDepegTrackerRows(
  a: DepegTrackerRow,
  b: DepegTrackerRow,
  sort: TableSortState<DepegTableSortKey>,
  nowSec?: number,
): number {
  if (sort.key === "__attention" || !(sort.key in defaultFieldExtractors)) {
    const delta = compareDepegAttention(a, b, nowSec);
    return sort.direction === "asc" ? -delta : delta;
  }
  const comparator =
    nowSec == null ? compareByDefaultField : createTableComparator<DepegFieldKey, DepegTrackerRow>(buildFieldExtractors(nowSec));
  return comparator(a, b, sort as TableSortState<DepegFieldKey>);
}
