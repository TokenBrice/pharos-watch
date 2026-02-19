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
import { Button } from "@/components/ui/button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortIcon } from "@/components/sort-icon";
import { useSort } from "@/hooks/use-sort";
import { formatCurrency } from "@/lib/format";
import { prettifyProtocol } from "@/lib/dex-constants";
import { getScoreColor } from "@/lib/severity-colors";
import type { StablecoinMeta, DexLiquidityData } from "@/lib/types";

const PAGE_SIZE = 25;

type SortKey = "score" | "tvl" | "effectiveTvl" | "tvlTrend" | "volume" | "volume7d" | "vtRatio" | "pools" | "chains" | "balance" | "organic" | "durability";

function BalanceBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const color = ratio >= 0.8 ? "bg-emerald-500" : ratio >= 0.5 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-10 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono tabular-nums text-xs w-7 text-right">{pct}%</span>
    </div>
  );
}

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
            <TableHead className="w-[200px]">Name</TableHead>
            <TableHead
              className="cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("score")}
              aria-sort={getAriaSortValue("score")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "score")}
            >
              Score <SortIcon columnKey="score" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("tvl")}
              aria-sort={getAriaSortValue("tvl")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "tvl")}
            >
              DEX TVL <SortIcon columnKey="tvl" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden lg:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("tvlTrend")}
              aria-sort={getAriaSortValue("tvlTrend")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "tvlTrend")}
            >
              7d Trend <SortIcon columnKey="tvlTrend" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("volume")}
              aria-sort={getAriaSortValue("volume")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "volume")}
            >
              24h Vol <SortIcon columnKey="volume" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden lg:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("volume7d")}
              aria-sort={getAriaSortValue("volume7d")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "volume7d")}
            >
              7d Vol <SortIcon columnKey="volume7d" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden sm:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("vtRatio")}
              aria-sort={getAriaSortValue("vtRatio")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "vtRatio")}
            >
              Vol/TVL <SortIcon columnKey="vtRatio" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden sm:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("pools")}
              aria-sort={getAriaSortValue("pools")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "pools")}
            >
              Pools <SortIcon columnKey="pools" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden sm:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("chains")}
              aria-sort={getAriaSortValue("chains")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "chains")}
            >
              Chains <SortIcon columnKey="chains" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead className="hidden md:table-cell text-left">Top Protocol</TableHead>
            <TableHead
              className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("effectiveTvl")}
              aria-sort={getAriaSortValue("effectiveTvl")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "effectiveTvl")}
            >
              Eff. TVL <SortIcon columnKey="effectiveTvl" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("balance")}
              aria-sort={getAriaSortValue("balance")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "balance")}
            >
              Balance <SortIcon columnKey="balance" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("organic")}
              aria-sort={getAriaSortValue("organic")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "organic")}
            >
              Organic <SortIcon columnKey="organic" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
            <TableHead
              className="hidden xl:table-cell cursor-pointer text-right hover:bg-muted/50 transition-colors"
              onClick={() => toggleSort("durability")}
              aria-sort={getAriaSortValue("durability")}
              tabIndex={0}
              onKeyDown={(e) => handleSortKeyDown(e, "durability")}
            >
              Durability <SortIcon columnKey="durability" sortKey={sortKey} sortDirection={sortDirection} />
            </TableHead>
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
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row.meta.id); } }}
                tabIndex={0}
              >
                <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                  {page * PAGE_SIZE + index + 1}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[row.meta.id]} name={row.meta.name} size={24} />
                    <span className="font-medium truncate max-w-[140px]">{row.meta.name}</span>
                    <span className="text-xs text-muted-foreground">{row.meta.symbol}</span>
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
                    <span className={`font-mono tabular-nums ${
                      liq.durabilityScore >= 70 ? "text-emerald-500" :
                      liq.durabilityScore >= 40 ? "text-amber-500" : "text-red-500"
                    }`}>{liq.durabilityScore}</span>
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
        <div className="flex items-center justify-between px-4 py-3 border-t">
          <span className="text-sm text-muted-foreground" aria-live="polite">
            Showing {sorted.length === 0 ? 0 : page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
