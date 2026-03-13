import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { createTableComparator } from "@/lib/table-comparator";
import { attentionScore, type DepegTrackerRow } from "@/lib/depeg-sort";

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

export function rowAccentClass(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "border-l-[3px] border-l-red-500";
  const band = row.dews?.band ?? "CALM";
  if (band === "WARNING" || band === "DANGER") return "border-l-[3px] border-l-orange-500";
  return "";
}

type DepegFieldKey = Exclude<DepegTableSortKey, "__attention">;

const fieldExtractors: Record<DepegFieldKey, (r: DepegTrackerRow) => number> = {
  pegScore: (r) => r.coin.pegScore ?? -1,
  dewsScore: (r) => r.dews?.score ?? -1,
  currentDeviationBps: (r) => Math.abs(r.coin.currentDeviationBps ?? 0),
  pegPct: (r) => r.coin.pegPct,
  eventCount: (r) => r.coin.eventCount,
  worstDeviationBps: (r) => Math.abs(r.coin.worstDeviationBps ?? 0),
  activeDepeg: (r) => (r.coin.activeDepeg ? 1 : 0),
  dexAgrees: (r) => (r.coin.dexPriceCheck?.agrees ? 1 : 0),
  trackingSpanDays: (r) => r.coin.trackingSpanDays,
};

const compareByField = createTableComparator<DepegTrackerRow, DepegFieldKey>(fieldExtractors);

export function compareDepegTrackerRows(
  a: DepegTrackerRow,
  b: DepegTrackerRow,
  sort: TableSortState<DepegTableSortKey>,
): number {
  // __attention and unknown keys always sort descending by composite attention score.
  if (sort.key === "__attention" || !(sort.key in fieldExtractors)) {
    return attentionScore(b) - attentionScore(a);
  }
  return compareByField(a, b, sort as TableSortState<DepegFieldKey>);
}
