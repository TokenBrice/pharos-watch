import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import type { BlacklistEvent } from "@shared/types";

export type BlacklistSortKey = "date" | "stablecoin" | "chain" | "event";

export function compareBlacklistRows(
  a: BlacklistEvent,
  b: BlacklistEvent,
  sort: TableSortState<BlacklistSortKey>,
): number {
  let cmp = 0;

  switch (sort.key) {
    case "date":
      cmp = a.timestamp - b.timestamp;
      break;
    case "stablecoin":
      cmp = a.stablecoin.localeCompare(b.stablecoin);
      break;
    case "chain":
      cmp = a.chainName.localeCompare(b.chainName);
      break;
    case "event":
      cmp = a.eventType.localeCompare(b.eventType);
      break;
    default:
      cmp = a.timestamp - b.timestamp;
      break;
  }

  return sort.direction === "asc" ? cmp : -cmp;
}
