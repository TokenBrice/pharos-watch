import { PRESSURE_SHIFT_STATE_VALUES, type PressureShiftState } from "@shared/lib/mint-burn-signals";
import { createTableComparator } from "@/lib/table-comparator";
import {
  resolveCoinNetFlow,
  resolvePressureScore as getPressureScore,
  resolvePressureState as getPressureState,
} from "@shared/lib/mint-burn-coin-helpers";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import type { MintBurnCoinFlow } from "@shared/types";
import { getFlowPressureUi } from "@/lib/flow-signal-ui";
import { FLOW_COVERAGE_BADGE_CLASSES } from "@shared/lib/classification";

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
  PRESSURE_SHIFT_STATE_VALUES.map((s) => [s, getFlowPressureUi(s).valueClass]),
) as Record<PressureShiftState, string>;

export function getCoverageBadge(coin: MintBurnCoinFlow): { label: string; className: string } | null {
  const status = coin.coverage?.status;
  if (!status || status === "full") return null;

  switch (status) {
    case "partial-history":
      return {
        label: "Partial history",
        className: FLOW_COVERAGE_BADGE_CLASSES["partial-history"],
      };
    case "lagging":
      return {
        label: "Lagging",
        className: FLOW_COVERAGE_BADGE_CLASSES.lagging,
      };
    case "bootstrapping":
      return {
        label: "Bootstrapping",
        className: FLOW_COVERAGE_BADGE_CLASSES.bootstrapping,
      };
    case "unknown":
      return {
        label: "Unknown",
        className: FLOW_COVERAGE_BADGE_CLASSES.unknown,
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
  // The net columns render a signed value, so ranking them by magnitude put a
  // large burn above a smaller mint in descending order. Unavailable nets (null
  // or partial valuation) sort last instead of ranking as zero.
  net24h: (r) => resolveCoinNetFlow(r, "24h").valueUsd,
  mint24h: (r) => r.mintVolume24hUsd,
  burn24h: (r) => r.burnVolume24hUsd,
  net7d: (r) => resolveCoinNetFlow(r, "7d").valueUsd,
  net30d: (r) => resolveCoinNetFlow(r, "30d").valueUsd,
  net90d: (r) => resolveCoinNetFlow(r, "90d").valueUsd,
  largest: (r) => r.largestEvent24h?.amountUsd ?? null,
  pressure: (r) => getPressureScore(r),
});

export function compareFlowRows(
  a: MintBurnCoinFlow,
  b: MintBurnCoinFlow,
  sort: TableSortState<FlowTableSortKey>,
): number {
  return _compareFlowRows(a, b, sort);
}
