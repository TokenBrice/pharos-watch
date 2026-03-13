import { getPressureShiftState, PRESSURE_SHIFT_STATE_VALUES, type PressureShiftState } from "@shared/lib/mint-burn-signals";
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

export function getPressureScore(coin: MintBurnCoinFlow): number | null {
  return coin.pressureShiftScore ?? coin.flowIntensity;
}

export function getPressureState(coin: MintBurnCoinFlow): PressureShiftState {
  return coin.pressureShiftState ?? getPressureShiftState(getPressureScore(coin));
}

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

export function compareFlowRows(
  a: MintBurnCoinFlow,
  b: MintBurnCoinFlow,
  sort: TableSortState<FlowTableSortKey>,
): number {
  let aVal: number;
  let bVal: number;

  switch (sort.key) {
    case "net24h":
      aVal = Math.abs(a.netFlow24hUsd);
      bVal = Math.abs(b.netFlow24hUsd);
      break;
    case "mint24h":
      aVal = a.mintVolume24hUsd;
      bVal = b.mintVolume24hUsd;
      break;
    case "burn24h":
      aVal = a.burnVolume24hUsd;
      bVal = b.burnVolume24hUsd;
      break;
    case "net7d":
      aVal = Math.abs(a.netFlow7dUsd);
      bVal = Math.abs(b.netFlow7dUsd);
      break;
    case "net30d":
      aVal = Math.abs(a.netFlow30dUsd);
      bVal = Math.abs(b.netFlow30dUsd);
      break;
    case "net90d":
      aVal = Math.abs(a.netFlow90dUsd);
      bVal = Math.abs(b.netFlow90dUsd);
      break;
    case "largest":
      aVal = a.largestEvent24h?.amountUsd ?? 0;
      bVal = b.largestEvent24h?.amountUsd ?? 0;
      break;
    case "pressure": {
      const aPressure = getPressureScore(a);
      const bPressure = getPressureScore(b);
      if (aPressure === null && bPressure === null) return 0;
      if (aPressure === null) return 1;
      if (bPressure === null) return -1;
      aVal = aPressure;
      bVal = bPressure;
      break;
    }
    default:
      aVal = Math.abs(a.netFlow24hUsd);
      bVal = Math.abs(b.netFlow24hUsd);
      break;
  }

  return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
}
