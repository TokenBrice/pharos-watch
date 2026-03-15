import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { createTableComparator } from "@/lib/table-comparator";
import type { BlacklistEvent } from "@shared/types";

export type BlacklistSortKey = "date" | "stablecoin" | "chain" | "event";

export const compareBlacklistRows: (
  a: BlacklistEvent,
  b: BlacklistEvent,
  sort: TableSortState<BlacklistSortKey>,
) => number = createTableComparator<BlacklistSortKey, BlacklistEvent>({
  date: (r) => r.timestamp,
  stablecoin: (r) => r.stablecoin,
  chain: (r) => r.chainName,
  event: (r) => r.eventType,
});
