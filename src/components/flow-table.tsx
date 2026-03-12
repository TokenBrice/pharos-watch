"use client";

import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortableTableHead } from "@/components/sortable-table-head";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Skeleton } from "@/components/ui/skeleton";
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
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
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

interface FlowTableProps {
  coins: MintBurnCoinFlow[];
  isLoading: boolean;
}

export function FlowTable({ coins, isLoading }: FlowTableProps) {
  const router = useRouter();
  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    handleSortKeyDown,
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
      <div className="scroll-shadow overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader className="bg-muted/80">
            <TableRow>
              <TableHead>Coin</TableHead>
              <TableHead className="text-right">Pressure vs 30D</TableHead>
              <TableHead className="text-right">Net 24h</TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                Minted 24h
              </TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                Burned 24h
              </TableHead>
              <TableHead className="hidden text-right md:table-cell">
                Net 7d
              </TableHead>
              <TableHead className="hidden text-right lg:table-cell">
                Net 30d
              </TableHead>
              <TableHead className="hidden text-right xl:table-cell">
                Net 90d
              </TableHead>
              <TableHead className="hidden text-right xl:table-cell">
                Largest Event
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, index) => (
              <TableRow key={index}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-6 w-6 rounded-full" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-10 w-24" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-8 w-20" />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  <Skeleton className="ml-auto h-4 w-16" />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  <Skeleton className="ml-auto h-4 w-16" />
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <Skeleton className="ml-auto h-4 w-16" />
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  <Skeleton className="ml-auto h-4 w-16" />
                </TableCell>
                <TableCell className="hidden text-right xl:table-cell">
                  <Skeleton className="ml-auto h-4 w-16" />
                </TableCell>
                <TableCell className="hidden text-right xl:table-cell">
                  <Skeleton className="ml-auto h-4 w-20" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="scroll-shadow overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader className="bg-muted/80">
          <TableRow>
            <TableHead>Coin</TableHead>
            <SortableTableHead
              sortKey="pressure"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Pressure vs 30D"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="net24h"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Net 24h"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="mint24h"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Minted 24h"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden text-right sm:table-cell"
            />
            <SortableTableHead
              sortKey="burn24h"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Burned 24h"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden text-right sm:table-cell"
            />
            <SortableTableHead
              sortKey="net7d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Net 7d"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden text-right md:table-cell"
            />
            <SortableTableHead
              sortKey="net30d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Net 30d"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden text-right lg:table-cell"
            />
            <SortableTableHead
              sortKey="net90d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Net 90d"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden text-right xl:table-cell"
            />
            <SortableTableHead
              sortKey="largest"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Largest Event"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden text-right xl:table-cell"
            />
          </TableRow>
        </TableHeader>
        <TableBody>
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
                  <div className="flex items-center gap-2">
                    <StablecoinLogo
                      src={logos?.[coin.stablecoinId]}
                      name={name}
                      size={24}
                    />
                    <div className="flex min-w-0 flex-col items-start gap-0.5">
                      <span className="font-medium">{coin.symbol}</span>
                      {coverageBadge && (
                        <span
                          className={cn(
                            "inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                            coverageBadge.className,
                          )}
                        >
                          {coverageBadge.label}
                        </span>
                      )}
                    </div>
                  </div>
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
                      : "NR"}
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
                      <span className="text-[10px] text-muted-foreground">partial</span>
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
                      <span className="text-[10px] text-muted-foreground">partial</span>
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
            <TableRow>
              <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                No mint/burn events in this period.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
