"use client";

import { useCallback } from "react";
import Image from "next/image";
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
import { TablePagination } from "@/components/table-pagination";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { BalanceBar } from "@/components/balance-bar";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { formatCurrency } from "@shared/lib/format";
import { prettifyProtocol, PROTOCOL_LOGOS } from "@/lib/dex-constants";
import { getScoreColor, getDurabilityColor } from "@/lib/severity-colors";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import type { StablecoinMeta, DexLiquidityData } from "@shared/types";

export type LiquiditySortKey =
  | "score"
  | "tvl"
  | "effectiveTvl"
  | "tvlTrend"
  | "volume"
  | "volume7d"
  | "vtRatio"
  | "pools"
  | "chains"
  | "balance"
  | "organic"
  | "durability";

export interface LiquidityRow {
  meta: StablecoinMeta;
  liq: DexLiquidityData;
}

interface LiquidityTableProps {
  rows: LiquidityRow[];
  logos: Record<string, string> | undefined;
  searchQuery: string;
  onRowClick: (id: string) => void;
}

export function compareLiquidityRows(
  a: LiquidityRow,
  b: LiquidityRow,
  sort: TableSortState<LiquiditySortKey>
): number {
  const aLiq = a.liq;
  const bLiq = b.liq;
  let aVal: number;
  let bVal: number;
  switch (sort.key) {
    case "score":
      aVal = aLiq.liquidityScore ?? 0;
      bVal = bLiq.liquidityScore ?? 0;
      break;
    case "tvl":
      aVal = aLiq.totalTvlUsd;
      bVal = bLiq.totalTvlUsd;
      break;
    case "tvlTrend":
      aVal = aLiq.tvlChange7d ?? 0;
      bVal = bLiq.tvlChange7d ?? 0;
      break;
    case "volume":
      aVal = aLiq.totalVolume24hUsd;
      bVal = bLiq.totalVolume24hUsd;
      break;
    case "volume7d":
      aVal = aLiq.totalVolume7dUsd;
      bVal = bLiq.totalVolume7dUsd;
      break;
    case "vtRatio":
      aVal = aLiq.totalTvlUsd > 0 ? aLiq.totalVolume24hUsd / aLiq.totalTvlUsd : 0;
      bVal = bLiq.totalTvlUsd > 0 ? bLiq.totalVolume24hUsd / bLiq.totalTvlUsd : 0;
      break;
    case "pools":
      aVal = aLiq.poolCount;
      bVal = bLiq.poolCount;
      break;
    case "chains":
      aVal = aLiq.chainCount;
      bVal = bLiq.chainCount;
      break;
    case "effectiveTvl":
      aVal = aLiq.effectiveTvlUsd ?? 0;
      bVal = bLiq.effectiveTvlUsd ?? 0;
      break;
    case "balance":
      aVal = aLiq.weightedBalanceRatio ?? 0;
      bVal = bLiq.weightedBalanceRatio ?? 0;
      break;
    case "organic":
      aVal = aLiq.organicFraction ?? 0;
      bVal = bLiq.organicFraction ?? 0;
      break;
    case "durability":
      aVal = aLiq.durabilityScore ?? 0;
      bVal = bLiq.durabilityScore ?? 0;
      break;
    default:
      aVal = aLiq.liquidityScore ?? 0;
      bVal = bLiq.liquidityScore ?? 0;
  }
  return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
}

export function LiquidityTable({ rows, logos, searchQuery, onRowClick }: LiquidityTableProps) {
  const compareRows = useCallback(
    (a: LiquidityRow, b: LiquidityRow, sort: TableSortState<LiquiditySortKey>) =>
      compareLiquidityRows(a, b, sort),
    []
  );

  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    handleSortKeyDown,
    sortedRows: sorted,
    effectivePage,
    totalPages,
    paginatedRows: paginated,
    pageStartIndex,
    rangeStart,
    rangeEnd,
    totalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<LiquidityRow, LiquiditySortKey>(
    rows,
    {
      defaultKey: "score",
      defaultDirection: "desc",
      compareRows,
      pageSize: TABLE_PAGE_SIZE,
      resetPageOnTotalChange: true,
    },
  );
  const prefetch = usePrefetchStablecoin();

  return (
    <div className="rounded-xl border overflow-x-auto scroll-shadow">
      <Table className="min-w-[420px]">
        <TableHeader className="bg-muted/80">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
            <TableHead className="w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none">Name</TableHead>
            <SortableTableHead
              sortKey="score"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Score"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="tvl"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="DEX TVL"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="tvlTrend"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="7d Trend"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden lg:table-cell text-right"
            />
            <SortableTableHead
              sortKey="volume"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="24h Vol"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="volume7d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="7d Vol"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden lg:table-cell text-right"
            />
            <SortableTableHead
              sortKey="vtRatio"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Vol/TVL"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden sm:table-cell text-right"
            />
            <SortableTableHead
              sortKey="pools"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Pools"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden sm:table-cell text-right"
            />
            <SortableTableHead
              sortKey="chains"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Chains"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden sm:table-cell text-right"
            />
            <TableHead className="hidden md:table-cell text-left">Top Protocol</TableHead>
            <SortableTableHead
              sortKey="effectiveTvl"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Eff. TVL"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden xl:table-cell text-right"
            />
            <SortableTableHead
              sortKey="balance"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Balance"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden xl:table-cell text-right"
            />
            <SortableTableHead
              sortKey="organic"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Organic"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden xl:table-cell text-right"
            />
            <SortableTableHead
              sortKey="durability"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Durability"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden xl:table-cell text-right"
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.map((row, index) => {
            const liq = row.liq;
            const vtRatio = liq.totalTvlUsd > 0 ? liq.totalVolume24hUsd / liq.totalTvlUsd : 0;
            const topProtocol = Object.entries(liq.protocolTvl).sort((a, b) => b[1] - a[1])[0];

            return (
              <InteractiveTableRow
                key={row.meta.id}
                onActivate={() => onRowClick(row.meta.id)}
                onHover={() => prefetch(row.meta.id)}
              >
                <TableCell className="text-right text-muted-foreground text-xs font-mono tabular-nums">
                  {pageStartIndex + index + 1}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[row.meta.id]} name={row.meta.name} size={24} />
                    <span className="font-medium">{row.meta.symbol}</span>
                    <span className="truncate max-w-[140px] text-xs text-muted-foreground hidden xl:inline">{row.meta.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  <span className={getScoreColor(liq.liquidityScore ?? 0)}>
                    {liq.liquidityScore ?? 0}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCurrency(liq.totalTvlUsd)}</TableCell>
                <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums text-sm">
                  {liq.tvlChange7d != null ? (
                    <span className={liq.tvlChange7d >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}>
                      {liq.tvlChange7d >= 0 ? "\u2191" : "\u2193"}{Math.abs(liq.tvlChange7d).toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCurrency(liq.totalVolume24hUsd)}</TableCell>
                <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums">{formatCurrency(liq.totalVolume7dUsd)}</TableCell>
                <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums text-sm">
                  {(vtRatio * 100).toFixed(1)}%
                </TableCell>
                <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">{liq.poolCount}</TableCell>
                <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">{liq.chainCount}</TableCell>
                <TableCell className="hidden md:table-cell text-left text-sm text-muted-foreground">
                  {topProtocol ? (
                    <span className="flex items-center gap-1.5">
                      {PROTOCOL_LOGOS[topProtocol[0]] && (
                        <Image src={PROTOCOL_LOGOS[topProtocol[0]]} alt="" width={16} height={16} className="rounded-full shrink-0" />
                      )}
                      {prettifyProtocol(topProtocol[0])}
                    </span>
                  ) : "—"}
                </TableCell>
                <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums">
                  {liq.effectiveTvlUsd ? formatCurrency(liq.effectiveTvlUsd) : "—"}
                </TableCell>
                <TableCell className="hidden xl:table-cell text-right">
                  {liq.weightedBalanceRatio != null ? (
                    <BalanceBar ratio={liq.weightedBalanceRatio} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums">
                  {liq.organicFraction != null ? `${Math.round(liq.organicFraction * 100)}%` : "—"}
                </TableCell>
                <TableCell className="hidden xl:table-cell text-right">
                  {liq.durabilityScore != null ? (
                    <span className={`font-mono tabular-nums ${getDurabilityColor(liq.durabilityScore)}`}>{liq.durabilityScore}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </InteractiveTableRow>
            );
          })}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={99} className="text-center text-muted-foreground py-12">
                {searchQuery ? `No results for "${searchQuery}"` : "No liquidity pools tracked for this stablecoin."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {sorted.length > 0 && (
        <TablePagination
          page={effectivePage}
          totalPages={totalPages}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          total={totalRows}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
          noun="stables tracked on DEXes"
        />
      )}
    </div>
  );
}
