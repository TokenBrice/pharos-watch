"use client";

import { useMemo } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useSort } from "@/hooks/use-sort";
import { useLogos } from "@/hooks/use-logos";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { formatCurrency, getNetColor, getNetPrefix } from "@/lib/format";
import { getFlowIntensityDisplay, getFlowIntensityMagnitude } from "@/lib/flow-intensity";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import type { MintBurnCoinFlow } from "@/lib/types";

interface FlowTableProps {
  coins: MintBurnCoinFlow[];
  isLoading: boolean;
}

type SortKey = "net24h" | "mint24h" | "burn24h" | "net7d" | "net30d" | "net90d" | "largest" | "fis";

export function FlowTable({ coins, isLoading }: FlowTableProps) {
  const router = useRouter();
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } =
    useSort<SortKey>("net30d", "desc");
  const { data: logos } = useLogos();
  const prefetch = usePrefetchStablecoin();

  const sorted = useMemo(() => {
    return [...coins].sort((a, b) => {
      let aVal: number;
      let bVal: number;
      switch (sortKey) {
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
        case "fis":
          if (a.flowIntensity === null && b.flowIntensity === null) return 0;
          if (a.flowIntensity === null) return 1;
          if (b.flowIntensity === null) return -1;
          aVal = a.flowIntensity;
          bVal = b.flowIntensity;
          break;
        default:
          aVal = Math.abs(a.netFlow24hUsd);
          bVal = Math.abs(b.netFlow24hUsd);
      }
      return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [coins, sortKey, sortDirection]);

  if (isLoading) {
    return (
      <div className="rounded-xl border overflow-x-auto scroll-shadow">
        <Table>
          <TableHeader className="bg-muted/80">
            <TableRow>
              <TableHead>Coin</TableHead>
              <TableHead className="text-right">Flow Intensity</TableHead>
              <TableHead className="text-right">Net 24h</TableHead>
              <TableHead className="hidden sm:table-cell text-right">Minted 24h</TableHead>
              <TableHead className="hidden sm:table-cell text-right">Burned 24h</TableHead>
              <TableHead className="hidden md:table-cell text-right">Net 7d</TableHead>
              <TableHead className="hidden lg:table-cell text-right">Net 30d</TableHead>
              <TableHead className="hidden xl:table-cell text-right">Net 90d</TableHead>
              <TableHead className="hidden xl:table-cell text-right">Largest Event</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell><div className="flex items-center gap-2"><Skeleton className="h-6 w-6 rounded-full" /><Skeleton className="h-4 w-12" /></div></TableCell>
                <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-20" /></TableCell>
                <TableCell className="text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                <TableCell className="hidden sm:table-cell text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                <TableCell className="hidden sm:table-cell text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                <TableCell className="hidden md:table-cell text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                <TableCell className="hidden lg:table-cell text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                <TableCell className="hidden xl:table-cell text-right"><Skeleton className="ml-auto h-4 w-16" /></TableCell>
                <TableCell className="hidden xl:table-cell text-right"><Skeleton className="ml-auto h-4 w-20" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="rounded-xl border overflow-x-auto scroll-shadow">
      <Table>
        <TableHeader className="bg-muted/80">
          <TableRow>
            <TableHead>Coin</TableHead>
            <SortableTableHead
              sortKey="fis"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Flow Intensity"
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
              className="hidden sm:table-cell text-right"
            />
            <SortableTableHead
              sortKey="burn24h"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Burned 24h"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden sm:table-cell text-right"
            />
            <SortableTableHead
              sortKey="net7d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Net 7d"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden md:table-cell text-right"
            />
            <SortableTableHead
              sortKey="net30d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Net 30d"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden lg:table-cell text-right"
            />
            <SortableTableHead
              sortKey="net90d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Net 90d"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden xl:table-cell text-right"
            />
            <SortableTableHead
              sortKey="largest"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Largest Event"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden xl:table-cell text-right"
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((coin) => {
            const meta = TRACKED_META_BY_ID.get(coin.stablecoinId);
            const name = meta?.name ?? coin.symbol;
            const intensityDisplay = coin.flowIntensity != null
              ? getFlowIntensityDisplay(coin.flowIntensity)
              : null;
            const intensityMagnitude = intensityDisplay != null
              ? getFlowIntensityMagnitude(intensityDisplay)
              : 0;
            const isNegativeIntensity = (intensityDisplay ?? 0) < 0;

            return (
              <TableRow
                key={coin.stablecoinId}
                className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                onClick={() => router.push(`/stablecoin/${coin.stablecoinId}`)}
                onMouseEnter={() => prefetch(coin.stablecoinId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    router.push(`/stablecoin/${coin.stablecoinId}`);
                  }
                }}
                tabIndex={0}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[coin.stablecoinId]} name={name} size={24} />
                    <span className="font-medium">{coin.symbol}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {coin.flowIntensity != null ? (
                    <div className="flex items-center justify-end gap-2">
                      <div className="hidden sm:flex h-2 w-16 overflow-hidden rounded-full bg-muted">
                        <div className="relative h-full w-1/2 border-r border-border/70">
                          {isNegativeIntensity && intensityMagnitude > 0 && (
                            <div
                              className="absolute right-0 top-0 h-full bg-red-500"
                              style={{ width: `${intensityMagnitude}%` }}
                            />
                          )}
                        </div>
                        <div className="relative h-full w-1/2">
                          {!isNegativeIntensity && intensityMagnitude > 0 && (
                            <div
                              className="absolute left-0 top-0 h-full bg-blue-500"
                              style={{ width: `${intensityMagnitude}%` }}
                            />
                          )}
                        </div>
                      </div>
                      <span className={`font-mono tabular-nums text-sm ${getNetColor(intensityDisplay ?? 0)}`}>
                        {getNetPrefix(intensityDisplay ?? 0)}{intensityDisplay}
                      </span>
                    </div>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">NR</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  <span className={getNetColor(coin.netFlow24hUsd)}>
                    {getNetPrefix(coin.netFlow24hUsd)}{formatCurrency(coin.netFlow24hUsd)}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">
                  {formatCurrency(coin.mintVolume24hUsd)}
                </TableCell>
                <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">
                  {formatCurrency(coin.burnVolume24hUsd)}
                </TableCell>
                <TableCell className="hidden md:table-cell text-right font-mono tabular-nums">
                  <span className={getNetColor(coin.netFlow7dUsd)}>
                    {getNetPrefix(coin.netFlow7dUsd)}{formatCurrency(coin.netFlow7dUsd)}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums">
                  <span className={getNetColor(coin.netFlow30dUsd)}>
                    {getNetPrefix(coin.netFlow30dUsd)}{formatCurrency(coin.netFlow30dUsd)}
                  </span>
                </TableCell>
                <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums">
                  <span className={getNetColor(coin.netFlow90dUsd)}>
                    {getNetPrefix(coin.netFlow90dUsd)}{formatCurrency(coin.netFlow90dUsd)}
                  </span>
                </TableCell>
                <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums">
                  {coin.largestEvent24h ? (
                    <span className={coin.largestEvent24h.direction === "mint" ? "text-emerald-500" : "text-red-500"}>
                      {coin.largestEvent24h.direction === "mint" ? "+" : "-"}{formatCurrency(coin.largestEvent24h.amountUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">&mdash;</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground py-12">
                No flow data available
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
