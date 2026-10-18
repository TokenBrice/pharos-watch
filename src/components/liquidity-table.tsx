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
import {
  compareLiquidityRows,
  informativeVolumeLowerBound,
  LIQUIDITY_NR_REASON_LABELS,
  type LiquidityRow,
  type LiquiditySortKey,
} from "@/components/liquidity-table-logic";
import { describeDexVolume } from "@/lib/dex-volume-display";
import { dexVolumeToTvlRatio } from "@shared/lib/dex-volume-availability";
import { MethodologyHint } from "@/components/methodology-hint";
import type { LiquidityScoreUnavailableReason } from "@shared/types/market";

export { type LiquidityRow, type LiquiditySortKey } from "@/components/liquidity-table-logic";

interface LiquidityTableProps {
  rows: LiquidityRow[];
  logos: Record<string, string> | undefined;
  searchQuery: string;
  onRowClick: (id: string) => void;
  /** Workbench toolbar (filters + search) rendered inside the table shell header. */
  toolbar?: ReactNode;
}

// Every column has a width so the fixed layout never ellipsizes a header; lower-value
// columns appear only where their width fits (7d volume at 2xl, Vol/TVL at xl).
const LIQUIDITY_COLUMNS: readonly DataTableColumn<LiquiditySortKey>[] = [
  { id: "rank", label: "#", className: "w-9 px-2 text-right sm:w-12 sm:px-3" },
  { id: "name", label: "Name", className: "w-[122px] max-w-[122px] sm:w-[150px] sm:max-w-[150px] xl:w-[170px] xl:max-w-none" },
  {
    id: "score",
    label: "Score",
    // Hidden below sm so "Score" fits the narrow phone column; the hero row keeps the hint.
    headerAdornment: <span className="hidden sm:inline-flex"><MethodologyHint topic="liquidityScore" /></span>,
    sortKey: "score",
    className: "w-[5.25rem] text-right sm:w-[7.25rem]",
  },
  { id: "tvl", label: "DEX TVL", sortKey: "tvl", className: "w-[6.5rem] text-right" },
  { id: "tvlTrend", label: "TVL 7d", sortKey: "tvlTrend", className: "hidden w-24 lg:table-cell text-right" },
  { id: "volume", label: "24h vol", sortKey: "volume", className: "w-[6.5rem] text-right" },
  { id: "volume7d", label: "7d vol", sortKey: "volume7d", className: "hidden w-[6.5rem] 2xl:table-cell text-right" },
  { id: "vtRatio", label: "Vol/TVL", sortKey: "vtRatio", className: "hidden w-24 xl:table-cell text-right" },
  { id: "pools", label: "Pools", sortKey: "pools", className: "hidden w-[4.75rem] sm:table-cell text-right" },
  { id: "chains", label: "Chains", sortKey: "chains", className: "hidden w-[5.25rem] sm:table-cell text-right" },
  { id: "topProtocol", label: "Top protocol", className: "hidden w-36 md:table-cell text-left" },
  { id: "balance", label: "Balance", sortKey: "balance", className: "hidden w-28 xl:table-cell text-right" },
  { id: "organic", label: "Organic", sortKey: "organic", className: "hidden w-[5.5rem] xl:table-cell text-right" },
  { id: "durability", label: "Durability", sortKey: "durability", className: "hidden w-28 xl:table-cell text-right" },
] as const;

/** NR plus the producer's reason; a row without a recorded reason says only NR. */
function NotRatedScore({ reason }: { reason: LiquidityScoreUnavailableReason | null }) {
  const label = reason ? LIQUIDITY_NR_REASON_LABELS[reason] : undefined;
  return (
    <span
      className="text-muted-foreground"
      data-reason-code={reason ?? undefined}
      title={label}
      aria-label={label ? `NR: ${label}` : "NR"}
    >
      NR
      {/* Below sm the label lives in the title so DEX TVL still fits on a phone. */}
      {label ? <span className="hidden text-2xs font-sans leading-tight sm:block">{label}</span> : null}
    </span>
  );
}

/**
 * A partial window shows its admitted sum as a muted lower bound, never as the
 * total (R1/R7). A bound of zero says nothing and reads like a measured zero, so
 * it stays an unavailable dash with the partial title.
 */
function VolumeCell({ volume }: { volume: ReturnType<typeof describeDexVolume> }) {
  if (volume.view.valueUsd != null) return volume.text;
  return <span className="text-muted-foreground">{informativeVolumeLowerBound(volume) ?? volume.text}</span>;
}

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
      <p className="pharos-meta sm:hidden">
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
          noun: "coins observed on DEX",
        }}
      >
        {paginated.map((row, index) => {
          const liq = row.liq;
          const vtRatio = dexVolumeToTvlRatio(liq.totalVolume24hUsd, liq.totalTvlUsd);
          const volume24h = describeDexVolume(liq.totalVolume24hUsd, liq.volume24hAvailability);
          const volume7d = describeDexVolume(liq.totalVolume7dUsd, liq.volume7dAvailability);
          const topProtocol = Object.entries(liq.protocolTvl).sort((a, b) => b[1] - a[1])[0];
          const coverageBadge = getLiquidityCoverageBadge(liq.coverageClass, liq.unavailableReason);

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
                {/* NR rows are not ranked: their order within the NR group is the active column's. */}
                {liq.liquidityScore != null ? pageStartIndex + index + 1 : "—"}
              </TableCell>
              <TableCell className="w-[122px] max-w-[122px] overflow-hidden sm:w-[150px] sm:max-w-[150px] xl:w-[170px] xl:max-w-none">
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
                      className={`text-3xs ${coverageBadge.className} ${coverageBadge.label === "Mixed" || coverageBadge.label === "Primary" ? "hidden sm:inline-flex" : ""}`}
                      title={liq.unavailableReason ?? formatLiquiditySourceMix(liq.sourceMix)}
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
                  <NotRatedScore reason={liq.liquidityScoreUnavailableReason ?? null} />
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
              <TableCell className="text-right pharos-numeric" title={volume24h.title}>
                <VolumeCell volume={volume24h} />
              </TableCell>
              <TableCell className="hidden 2xl:table-cell text-right pharos-numeric" title={volume7d.title}>
                <VolumeCell volume={volume7d} />
              </TableCell>
              <TableCell className="hidden xl:table-cell text-right pharos-numeric text-sm">
                {vtRatio != null ? formatPercent(vtRatio * 100, 1) : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right pharos-numeric">{liq.poolCount}</TableCell>
              <TableCell className="hidden sm:table-cell text-right pharos-numeric">{liq.chainCount}</TableCell>
              <TableCell className="hidden md:table-cell text-left text-sm text-muted-foreground">
                {topProtocol ? (
                  <span className="flex min-w-0 items-center gap-1.5">
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
                    <span className="truncate">{prettifyProtocol(topProtocol[0])}</span>
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
