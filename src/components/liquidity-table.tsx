"use client";

import Image from "next/image";
import {
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { BalanceBar } from "@/components/balance-bar";
import { Badge } from "@/components/ui/badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { prettifyProtocol, PROTOCOL_LOGOS } from "@/lib/dex-display-constants";
import { formatLiquiditySourceMix, getLiquidityCoverageBadge } from "@/lib/liquidity-coverage";
import { getScoreColor, getDurabilityColor } from "@/lib/severity-colors";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareLiquidityRows, type LiquidityRow, type LiquiditySortKey } from "@/components/liquidity-table-logic";
import { MethodologyHint } from "@/components/methodology-hint";

export { compareLiquidityRows, type LiquidityRow, type LiquiditySortKey } from "@/components/liquidity-table-logic";

interface LiquidityTableProps {
  rows: LiquidityRow[];
  logos: Record<string, string> | undefined;
  searchQuery: string;
  onRowClick: (id: string) => void;
}

const LIQUIDITY_COLUMNS: readonly DataTableColumn<LiquiditySortKey>[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "name", label: "Name", className: "w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none" },
  { id: "score", label: "Score", headerAdornment: <MethodologyHint topic="liquidityScore" />, sortKey: "score", className: "text-right" },
  { id: "tvl", label: "DEX TVL", sortKey: "tvl", className: "text-right" },
  { id: "tvlTrend", label: "7d Trend", sortKey: "tvlTrend", className: "hidden lg:table-cell text-right" },
  { id: "volume", label: "24h Vol", sortKey: "volume", className: "text-right" },
  { id: "volume7d", label: "7d Vol", sortKey: "volume7d", className: "hidden lg:table-cell text-right" },
  { id: "vtRatio", label: "Vol/TVL", sortKey: "vtRatio", className: "hidden sm:table-cell text-right" },
  { id: "pools", label: "Pools", sortKey: "pools", className: "hidden sm:table-cell text-right" },
  { id: "chains", label: "Chains", sortKey: "chains", className: "hidden sm:table-cell text-right" },
  { id: "topProtocol", label: "Top Protocol", className: "hidden md:table-cell text-left" },
  { id: "balance", label: "Balance", sortKey: "balance", className: "hidden xl:table-cell text-right" },
  { id: "organic", label: "Organic", sortKey: "organic", className: "hidden xl:table-cell text-right" },
  { id: "durability", label: "Durability", sortKey: "durability", className: "hidden xl:table-cell text-right" },
] as const;

export function LiquidityTable({ rows, logos, searchQuery, onRowClick }: LiquidityTableProps) {
  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
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
      compareRows: compareLiquidityRows,
      pageSize: TABLE_PAGE_SIZE,
      resetPageOnTotalChange: true,
    },
  );
  const prefetch = usePrefetchStablecoin();

  return (
    <DataTableShell
      columns={LIQUIDITY_COLUMNS}
      striped
      sort={{
        sortKey,
        sortDirection,
        toggleSort,
        getAriaSortValue,
      }}
      tableClassName="min-w-[420px]"
      pagination={{
        page: effectivePage,
        totalPages,
        rangeStart,
        rangeEnd,
        total: totalRows,
        onPrevious: onPreviousPage,
        onNext: onNextPage,
        noun: "stables tracked on DEXes",
      }}
    >
      {paginated.map((row, index) => {
            const liq = row.liq;
            const vtRatio = liq.totalTvlUsd > 0 ? liq.totalVolume24hUsd / liq.totalTvlUsd : 0;
            const topProtocol = Object.entries(liq.protocolTvl).sort((a, b) => b[1] - a[1])[0];
            const coverageBadge = getLiquidityCoverageBadge(liq.coverageClass ?? "unobserved");

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
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{row.meta.symbol}</span>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${coverageBadge.className}`}
                          title={formatLiquiditySourceMix(liq.sourceMix)}
                        >
                          {coverageBadge.label}
                        </Badge>
                      </div>
                      <span className="truncate max-w-[140px] text-xs text-muted-foreground hidden xl:inline">{row.meta.name}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {liq.liquidityScore != null ? (
                    <span className={getScoreColor(liq.liquidityScore)}>
                      {liq.liquidityScore}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">NR</span>
                  )}
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
                  {formatPercent(vtRatio * 100, 1)}
                </TableCell>
                <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">{liq.poolCount}</TableCell>
                <TableCell className="hidden sm:table-cell text-right font-mono tabular-nums">{liq.chainCount}</TableCell>
                <TableCell className="hidden md:table-cell text-left text-sm text-muted-foreground">
                  {topProtocol ? (
                    <span className="flex items-center gap-1.5">
                      {PROTOCOL_LOGOS[topProtocol[0]] && (
                        <Image src={PROTOCOL_LOGOS[topProtocol[0]]} alt="" width={16} height={16} className="rounded-full shrink-0" aria-hidden="true" />
                      )}
                      {prettifyProtocol(topProtocol[0])}
                    </span>
                  ) : "—"}
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
          <TableCell colSpan={LIQUIDITY_COLUMNS.length} className="text-center text-muted-foreground py-12">
            {searchQuery ? `No results for "${searchQuery}"` : "No stablecoins match the current filters."}
          </TableCell>
        </TableRow>
      )}
    </DataTableShell>
  );
}
