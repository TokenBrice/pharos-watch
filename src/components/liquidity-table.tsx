"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import { TableCell } from "@/components/table";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { BalanceBar } from "@/components/balance-bar";
import { Badge } from "@/components/ui/badge";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { formatCurrency, formatPercent, getNetColor } from "@shared/lib/format";
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
  /** Workbench toolbar (filters + search) rendered inside the table shell header. */
  toolbar?: ReactNode;
}

const LIQUIDITY_COLUMNS: readonly DataTableColumn<LiquiditySortKey>[] = [
  { id: "rank", label: "#", className: "w-9 px-2 text-right sm:w-[50px] sm:px-3" },
  { id: "name", label: "Name", className: "w-[122px] max-w-[122px] sm:w-[150px] sm:max-w-[150px] xl:w-[200px] xl:max-w-none" },
  {
    id: "score",
    label: "Score",
    headerAdornment: <MethodologyHint topic="liquidityScore" />,
    sortKey: "score",
    className: "w-[84px] text-right",
  },
  { id: "tvl", label: "DEX TVL", sortKey: "tvl", className: "w-[104px] text-right" },
  { id: "tvlTrend", label: "7d Trend", sortKey: "tvlTrend", className: "hidden lg:table-cell text-right" },
  { id: "volume", label: "24h Vol", sortKey: "volume", className: "w-[104px] text-right" },
  { id: "volume7d", label: "7d Vol", sortKey: "volume7d", className: "hidden lg:table-cell text-right" },
  { id: "vtRatio", label: "Vol/TVL", sortKey: "vtRatio", className: "hidden sm:table-cell text-right" },
  { id: "pools", label: "Pools", sortKey: "pools", className: "hidden sm:table-cell text-right" },
  { id: "chains", label: "Chains", sortKey: "chains", className: "hidden sm:table-cell text-right" },
  { id: "topProtocol", label: "Top Protocol", className: "hidden md:table-cell text-left" },
  { id: "balance", label: "Balance", sortKey: "balance", className: "hidden xl:table-cell text-right" },
  { id: "organic", label: "Organic", sortKey: "organic", className: "hidden xl:table-cell text-right" },
  { id: "durability", label: "Durability", sortKey: "durability", className: "hidden xl:table-cell text-right" },
] as const;

export function LiquidityTable({ rows, logos, searchQuery, onRowClick, toolbar }: LiquidityTableProps) {
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
  } = useSortedPaginatedTable<LiquidityRow, LiquiditySortKey>(rows, {
    defaultKey: "score",
    defaultDirection: "desc",
    compareRows: compareLiquidityRows,
    pageSize: TABLE_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });
  const prefetch = usePrefetchStablecoin();

  return (
    <div className="space-y-2">
      <p className="sm:hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Swipe table for volume, pool, chain, and protocol fields.
      </p>
      <DataTableShell
        tableId="liquidity-leaderboard"
        testId="liquidity-leaderboard-table"
        columns={LIQUIDITY_COLUMNS}
        topSlot={toolbar ? <div className="pharos-table-toolbar">{toolbar}</div> : undefined}
        striped
        sort={{
          sortKey,
          sortDirection,
          toggleSort,
          getAriaSortValue,
        }}
        mobileScrollHint={false}
        viewportClassName="pb-[calc(var(--mobile-utility-safe-offset)-1rem)] sm:pb-0"
        viewportProps={{ compactBottomPadding: false }}
        tableClassName="min-w-[360px] sm:min-w-[450px] table-fixed"
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
              role="link"
              ariaLabel={`Open ${row.meta.symbol} liquidity detail`}
              className="h-11 sm:h-auto"
            >
              <TableCell className="px-2 text-right text-muted-foreground text-xs pharos-numeric sm:px-3">
                {pageStartIndex + index + 1}
              </TableCell>
              <TableCell className="w-[122px] max-w-[122px] overflow-hidden sm:w-[150px] sm:max-w-[150px] xl:w-[200px] xl:max-w-none">
                <StablecoinIdentity
                  logoSrc={logos?.[row.meta.id]}
                  name={row.meta.name}
                  symbol={row.meta.symbol}
                  logoSize={24}
                  className="min-w-0"
                  textClassName="min-w-0"
                  symbolRowClassName="min-w-0 gap-1.5"
                  symbolClassName="truncate"
                  badge={
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${coverageBadge.className}`}
                      title={formatLiquiditySourceMix(liq.sourceMix)}
                    >
                      {coverageBadge.label}
                    </Badge>
                  }
                  nameClassName="truncate max-w-[140px] text-xs text-muted-foreground hidden xl:inline"
                />
              </TableCell>
              <TableCell className="text-right pharos-numeric">
                {liq.liquidityScore != null ? (
                  <span className={getScoreColor(liq.liquidityScore)}>{liq.liquidityScore}</span>
                ) : (
                  <span className="text-muted-foreground">NR</span>
                )}
              </TableCell>
              <TableCell className="text-right pharos-numeric">{formatCurrency(liq.totalTvlUsd)}</TableCell>
              <TableCell className="hidden lg:table-cell text-right pharos-numeric text-sm">
                {liq.tvlChange7d != null ? (
                  <span className={getNetColor(liq.tvlChange7d, { positiveInclusiveZero: true })}>
                    {liq.tvlChange7d >= 0 ? "\u2191" : "\u2193"}
                    {Math.abs(liq.tvlChange7d).toFixed(1)}%
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right pharos-numeric">
                {formatCurrency(liq.totalVolume24hUsd)}
              </TableCell>
              <TableCell className="hidden lg:table-cell text-right pharos-numeric">
                {liq.totalVolume7dUsd != null ? formatCurrency(liq.totalVolume7dUsd) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right pharos-numeric text-sm">
                {formatPercent(vtRatio * 100, 1)}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right pharos-numeric">{liq.poolCount}</TableCell>
              <TableCell className="hidden sm:table-cell text-right pharos-numeric">{liq.chainCount}</TableCell>
              <TableCell className="hidden md:table-cell text-left text-sm text-muted-foreground">
                {topProtocol ? (
                  <span className="flex items-center gap-1.5">
                    {PROTOCOL_LOGOS[topProtocol[0]] && (
                      <Image
                        src={PROTOCOL_LOGOS[topProtocol[0]]}
                        alt=""
                        width={16}
                        height={16}
                        className="rounded-full shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    {prettifyProtocol(topProtocol[0])}
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="hidden xl:table-cell text-right">
                {liq.weightedBalanceRatio != null ? (
                  <BalanceBar ratio={liq.weightedBalanceRatio} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="hidden xl:table-cell text-right pharos-numeric">
                {liq.organicFraction != null ? `${Math.round(liq.organicFraction * 100)}%` : "—"}
              </TableCell>
              <TableCell className="hidden xl:table-cell text-right">
                {liq.durabilityScore != null ? (
                  <span className={`pharos-numeric ${getDurabilityColor(liq.durabilityScore)}`}>
                    {liq.durabilityScore}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </InteractiveTableRow>
          );
        })}
        {sorted.length === 0 && (
          <DataTableEmptyRow colSpan={LIQUIDITY_COLUMNS.length}>
            {searchQuery
              ? `Nothing matched "${searchQuery}". Try a symbol like USDT.`
              : "No coins match. Loosen the filter."}
          </DataTableEmptyRow>
        )}
      </DataTableShell>
    </div>
  );
}
