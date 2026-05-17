"use client";

import { useRouter } from "next/navigation";
import {
  TableCell,
} from "@/components/ui/table";
import {
  DataTableEmptyRow,
  DataTableLoadingRows,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLogos } from "@/hooks/use-logos";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedTableRows } from "@/hooks/use-sorted-table-rows";
import {
  formatCurrency,
  getNetColor,
  getNetPrefix,
} from "@shared/lib/format";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { buildStablecoinUrl } from "@/lib/urls";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { MintBurnCoinFlow } from "@shared/types";
import { cn } from "@/lib/utils";
import {
  compareFlowRows,
  getCoverageBadge,
  getPressureScore,
  getPressureState,
  PRESSURE_VALUE_CLASS,
  type FlowTableSortKey,
} from "@/components/flow-table-logic";
import { MethodologyHint } from "@/components/methodology-hint";

interface FlowTableProps {
  coins: MintBurnCoinFlow[];
  isLoading: boolean;
}

const FLOW_TABLE_COLUMNS: readonly DataTableColumn<FlowTableSortKey>[] = [
  { id: "coin", label: "Coin" },
  {
    id: "pressure",
    label: "Pressure vs 30D",
    headerAdornment: <MethodologyHint topic="pressureShift" />,
    sortKey: "pressure",
    className: "text-right",
  },
  { id: "net24h", label: "Net 24h", sortKey: "net24h", className: "text-right" },
  { id: "mint24h", label: "Minted 24h", sortKey: "mint24h", className: "hidden text-right sm:table-cell" },
  { id: "burn24h", label: "Burned 24h", sortKey: "burn24h", className: "hidden text-right sm:table-cell" },
  { id: "net7d", label: "Net 7d", sortKey: "net7d", className: "hidden text-right md:table-cell" },
  { id: "net30d", label: "Net 30d", sortKey: "net30d", className: "hidden text-right lg:table-cell" },
  { id: "net90d", label: "Net 90d", sortKey: "net90d", className: "hidden text-right xl:table-cell" },
  { id: "largest", label: "Largest Event", sortKey: "largest", className: "hidden text-right xl:table-cell" },
] as const;

export function FlowTable({ coins, isLoading }: FlowTableProps) {
  const router = useRouter();
  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    sortedRows: sorted,
  } = useSortedTableRows<MintBurnCoinFlow, FlowTableSortKey>(
    coins,
    { defaultKey: "net24h", defaultDirection: "desc" },
    compareFlowRows,
  );
  const { data: logos } = useLogos();
  const prefetch = usePrefetchStablecoin();

  if (isLoading) {
    return (
      <DataTableShell columns={FLOW_TABLE_COLUMNS} striped>
        <DataTableLoadingRows columns={FLOW_TABLE_COLUMNS} rowCount={5} />
      </DataTableShell>
    );
  }

  return (
    <DataTableShell
      columns={FLOW_TABLE_COLUMNS}
      striped
      sort={{
        sortKey,
        sortDirection,
        toggleSort,
        getAriaSortValue,
      }}
    >
      {sorted.map((coin) => {
            const meta = TRACKED_META_BY_ID.get(coin.stablecoinId);
            const name = meta?.name ?? coin.symbol;
            const pressureScore = getPressureScore(coin);
            const pressureState = getPressureState(coin);
            const coverageBadge = getCoverageBadge(coin);
            const pressureDisplay = pressureScore != null
              ? getPressureShiftDisplay(pressureScore)
              : null;
            return (
              <InteractiveTableRow
                key={coin.stablecoinId}
                onActivate={() => router.push(buildStablecoinUrl(coin.stablecoinId))}
                onHover={() => prefetch(coin.stablecoinId)}
              >
                <TableCell>
                  <StablecoinIdentity
                    logoSrc={logos?.[coin.stablecoinId]}
                    name={name}
                    symbol={coin.symbol}
                    logoSize={24}
                    textClassName="flex min-w-0 flex-col items-start gap-0.5"
                    details={
                      coverageBadge ? (
                        <span
                          className={cn(
                            "inline-flex rounded-full border px-1.5 py-0.5 text-xs font-medium leading-none",
                            coverageBadge.className,
                          )}
                        >
                          {coverageBadge.label}
                        </span>
                      ) : null
                    }
                  />
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={cn(
                      "font-mono tabular-nums text-sm font-semibold",
                      PRESSURE_VALUE_CLASS[pressureState],
                    )}
                  >
                    {pressureDisplay != null
                      ? `${getNetPrefix(pressureDisplay)}${pressureDisplay}`
                      : (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>NR</span>
                            </TooltipTrigger>
                            <TooltipContent>Needs at least 7 days of data plus current activity</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={cn(
                      "font-mono tabular-nums text-sm font-semibold",
                      getNetColor(coin.netFlow24hUsd),
                    )}
                  >
                    {getNetPrefix(coin.netFlow24hUsd)}
                    {formatCurrency(coin.netFlow24hUsd)}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">
                  {formatCurrency(coin.mintVolume24hUsd)}
                </TableCell>
                <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">
                  {formatCurrency(coin.burnVolume24hUsd)}
                </TableCell>
                <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">
                  <span className={getNetColor(coin.netFlow7dUsd)}>
                    {getNetPrefix(coin.netFlow7dUsd)}
                    {formatCurrency(coin.netFlow7dUsd)}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell">
                  <div
                    className="flex items-center justify-end gap-1"
                    title={
                      coin.coverage?.has30dWindow === false
                        ? "30-day window is incomplete; value reflects the covered portion only."
                        : undefined
                    }
                  >
                    <span
                      className={cn(
                        getNetColor(coin.netFlow30dUsd),
                        coin.coverage?.has30dWindow === false && "opacity-60",
                      )}
                    >
                      {getNetPrefix(coin.netFlow30dUsd)}
                      {formatCurrency(coin.netFlow30dUsd)}
                    </span>
                    {coin.coverage?.has30dWindow === false && (
                      <span className="text-xs text-muted-foreground">partial</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden text-right font-mono tabular-nums xl:table-cell">
                  <div
                    className="flex items-center justify-end gap-1"
                    title={
                      coin.coverage?.has90dWindow === false
                        ? "90-day window is incomplete; value reflects the covered portion only."
                        : undefined
                    }
                  >
                    <span
                      className={cn(
                        getNetColor(coin.netFlow90dUsd),
                        coin.coverage?.has90dWindow === false && "opacity-60",
                      )}
                    >
                      {getNetPrefix(coin.netFlow90dUsd)}
                      {formatCurrency(coin.netFlow90dUsd)}
                    </span>
                    {coin.coverage?.has90dWindow === false && (
                      <span className="text-xs text-muted-foreground">partial</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden text-right font-mono tabular-nums xl:table-cell">
                  {coin.largestEvent24h ? (
                    <span
                      className={
                        coin.largestEvent24h.direction === "mint"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-red-700 dark:text-red-400"
                      }
                    >
                      {coin.largestEvent24h.direction === "mint" ? "+" : "-"}
                      {formatCurrency(coin.largestEvent24h.amountUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">&mdash;</span>
                  )}
                </TableCell>
              </InteractiveTableRow>
            );
      })}
      {sorted.length === 0 && (
        <DataTableEmptyRow colSpan={FLOW_TABLE_COLUMNS.length}>
          No mint/burn events in this period.
        </DataTableEmptyRow>
      )}
    </DataTableShell>
  );
}
