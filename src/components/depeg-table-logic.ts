import type { TableSortState } from "@/hooks/use-sorted-table-rows";
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

export function compareDepegTrackerRows(
  a: DepegTrackerRow,
  b: DepegTrackerRow,
  sort: TableSortState<DepegTableSortKey>,
): number {
  if (sort.key === "__attention") {
    return attentionScore(b) - attentionScore(a);
  }

  let aVal: number;
  let bVal: number;

  switch (sort.key) {
    case "pegScore":
      aVal = a.coin.pegScore ?? -1;
      bVal = b.coin.pegScore ?? -1;
      break;
    case "dewsScore":
      aVal = a.dews?.score ?? -1;
      bVal = b.dews?.score ?? -1;
      break;
    case "currentDeviationBps":
      aVal = Math.abs(a.coin.currentDeviationBps ?? 0);
      bVal = Math.abs(b.coin.currentDeviationBps ?? 0);
      break;
    case "pegPct":
      aVal = a.coin.pegPct;
      bVal = b.coin.pegPct;
      break;
    case "eventCount":
      aVal = a.coin.eventCount;
      bVal = b.coin.eventCount;
      break;
    case "worstDeviationBps":
      aVal = Math.abs(a.coin.worstDeviationBps ?? 0);
      bVal = Math.abs(b.coin.worstDeviationBps ?? 0);
      break;
    case "activeDepeg":
      aVal = a.coin.activeDepeg ? 1 : 0;
      bVal = b.coin.activeDepeg ? 1 : 0;
      break;
    case "dexAgrees":
      aVal = a.coin.dexPriceCheck?.agrees ? 1 : 0;
      bVal = b.coin.dexPriceCheck?.agrees ? 1 : 0;
      break;
    case "trackingSpanDays":
      aVal = a.coin.trackingSpanDays;
      bVal = b.coin.trackingSpanDays;
      break;
    default:
      return attentionScore(b) - attentionScore(a);
  }

  return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
}
