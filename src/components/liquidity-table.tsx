"use client";

import { useState, useMemo } from "react";
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
import { BalanceBar } from "@/components/balance-bar";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { formatCurrency } from "@/lib/format";
import { prettifyProtocol } from "@/lib/dex-constants";
import { getScoreColor, getDurabilityColor } from "@/lib/severity-colors";
import type { StablecoinMeta, DexLiquidityData } from "@/lib/types";

const PAGE_SIZE = 25;

type SortKey = "score" | "tvl" | "effectiveTvl" | "tvlTrend" | "volume" | "volume7d" | "vtRatio" | "pools" | "chains" | "balance" | "organic" | "durability";

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

export function LiquidityTable({ rows, logos, searchQuery, onRowClick }: LiquidityTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<SortKey>("score", "desc");
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const [page, setPage] = useState(0);
  const prefetch = usePrefetchStablecoin();

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aLiq = a.liq;
      const bLiq = b.liq;
      let aVal: number, bVal: number;
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
    });
  }, [rows, sort]);

  // Reset page when rows change (filter/search change causes new rows array)
  const [prevRowCount, setPrevRowCount] = useState(rows.length);
  if (prevRowCount !== rows.length) {
    setPrevRowCount(rows.length);
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="rounded-xl border overflow-x-auto table-striped scroll-shadow">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
            <TableHead className="xl:w-[200px]">Name</TableHead>
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
              <TableRow
                key={row.meta.id}
                className="hover:bg-muted/70 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                onClick={() => onRowClick(row.meta.id)}
                onMouseEnter={() => prefetch(row.meta.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row.meta.id); } }}
                tabIndex={0}
              >
                <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                  {page * PAGE_SIZE + index + 1}
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
                    <span className={liq.tvlChange7d >= 0 ? "text-emerald-500" : "text-red-500"}>
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
                  {topProtocol ? prettifyProtocol(topProtocol[0]) : "—"}
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
              </TableRow>
            );
          })}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={99} className="text-center text-muted-foreground py-8">
                {searchQuery ? `No results for "${searchQuery}"` : "No liquidity data available"}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {sorted.length > 0 && (
        <TablePagination
          page={page}
          totalPages={totalPages}
          rangeStart={sorted.length === 0 ? 0 : page * PAGE_SIZE + 1}
          rangeEnd={Math.min((page + 1) * PAGE_SIZE, sorted.length)}
          total={sorted.length}
          onPrevious={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          noun="pools"
        />
      )}
    </div>
  );
}
