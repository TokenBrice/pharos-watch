import { PRESSURE_SHIFT_STATE_VALUES, type PressureShiftState } from "@shared/lib/mint-burn-signals";
import { createTableComparator } from "@/lib/table-comparator";
import {
  resolvePressureScore as getPressureScore,
  resolvePressureState as getPressureState,
} from "@/lib/mint-burn-coin-helpers";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import type { MintBurnCoinFlow } from "@shared/types";
import { getFlowPressureUi } from "@/lib/flow-signal-ui";

export type FlowTableSortKey =
  | "net24h"
  | "mint24h"
  | "burn24h"
  | "net7d"
  | "net30d"
  | "net90d"
  | "largest"
  | "pressure";

export { getPressureScore, getPressureState };

export const PRESSURE_VALUE_CLASS: Record<PressureShiftState, string> = Object.fromEntries(
  PRESSURE_SHIFT_STATE_VALUES.map((s) => [s, getFlowPressureUi(s, "summary").valueClass]),
) as Record<PressureShiftState, string>;

export function getCoverageBadge(coin: MintBurnCoinFlow): { label: string; className: string } | null {
  const status = coin.coverage?.status;
  if (!status || status === "full") return null;

  switch (status) {
    case "partial-history":
      return {
        label: "Partial history",
        className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "lagging":
      return {
        label: "Lagging",
        className: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
      };
    case "bootstrapping":
      return {
        label: "Bootstrapping",
        className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      };
    case "disabled":
      return {
        label: "Disabled",
        className: "border-muted-foreground/20 bg-muted/40 text-muted-foreground",
      };
    default:
      return null;
  }
}

const _compareFlowRows = createTableComparator<FlowTableSortKey, MintBurnCoinFlow>({
  net24h: (r) => Math.abs(r.netFlow24hUsd),
  mint24h: (r) => r.mintVolume24hUsd,
  burn24h: (r) => r.burnVolume24hUsd,
  net7d: (r) => Math.abs(r.netFlow7dUsd),
  net30d: (r) => Math.abs(r.netFlow30dUsd),
  net90d: (r) => Math.abs(r.netFlow90dUsd),
  largest: (r) => r.largestEvent24h?.amountUsd ?? 0,
  pressure: (r) => getPressureScore(r),
});

export function compareFlowRows(
  a: MintBurnCoinFlow,
  b: MintBurnCoinFlow,
  sort: TableSortState<FlowTableSortKey>,
): number {
  return _compareFlowRows(a, b, sort);
}
