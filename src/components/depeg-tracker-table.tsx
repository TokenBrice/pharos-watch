"use client";

import {
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DEWSBadge } from "@/components/dews-badge";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import { type DepegTrackerRow } from "@/lib/depeg-sort";
import type { ThreatBand } from "@shared/lib/classification";
import { formatPercent, formatTrackingSpanDays } from "@shared/lib/format";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import {
  compareDepegTrackerRows,
  rowAccentClass,
  type DepegTableSortKey,
} from "@/components/depeg-table-logic";
import { MethodologyLabel } from "@/components/methodology-hint";

export type { DepegTrackerRow } from "@/lib/depeg-sort";

interface DepegTrackerTableProps {
  rows: DepegTrackerRow[];
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
}

const DEPEG_TRACKER_COLUMNS: readonly DataTableColumn<DepegTableSortKey>[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "name", label: "Name", className: "w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none" },
  { id: "pegScore", label: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>, sortKey: "pegScore", className: "text-right" },
  { id: "dewsScore", label: <MethodologyLabel topic="dews">DEWS</MethodologyLabel>, sortKey: "dewsScore", className: "text-right" },
  { id: "currentDeviationBps", label: "Deviation", sortKey: "currentDeviationBps", className: "text-right" },
  { id: "pegPct", label: "Peg %", sortKey: "pegPct", className: "text-right hidden md:table-cell" },
  { id: "eventCount", label: "Events", sortKey: "eventCount", className: "text-right hidden md:table-cell" },
  { id: "worstDeviationBps", label: "Worst", sortKey: "worstDeviationBps", className: "text-right hidden lg:table-cell" },
  { id: "dexAgrees", label: "DEX Cross-check", sortKey: "dexAgrees", className: "text-center hidden xl:table-cell" },
  { id: "trackingSpanDays", label: "Tracking", sortKey: "trackingSpanDays", className: "text-right hidden xl:table-cell" },
] as const;

export function DepegTrackerTable({ rows, logos, onRowClick }: DepegTrackerTableProps) {
  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    handleSortKeyDown,
    effectivePage,
    totalPages,
    paginatedRows: paginated,
    pageStartIndex,
    rangeStart,
    rangeEnd,
    totalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<DepegTrackerRow, DepegTableSortKey>(
    rows,
    {
      defaultKey: "__attention",
      defaultDirection: "desc",
      compareRows: compareDepegTrackerRows,
      pageSize: TABLE_PAGE_SIZE,
    },
  );
  const prefetch = usePrefetchStablecoin();

  return (
    <DataTableShell
      columns={DEPEG_TRACKER_COLUMNS}
      sort={{
        sortKey,
        sortDirection,
        toggleSort,
        getAriaSortValue,
        handleSortKeyDown,
      }}
      striped
      tableClassName="min-w-[420px]"
      pagination={{
        page: effectivePage,
        totalPages,
        rangeStart,
        rangeEnd,
        total: totalRows,
        onPrevious: onPreviousPage,
        onNext: onNextPage,
        noun: "stablecoins",
      }}
    >
      {paginated.map((row, i) => {
            const coin = row.coin;
            const dews = row.dews;
            const absDev = Math.abs(coin.currentDeviationBps ?? 0);
            const accent = rowAccentClass(row);
            const rank = pageStartIndex + i + 1;
            const provenanceLabel = [coin.priceSource ?? "unknown source", coin.priceConfidence ?? "unknown confidence"].join(" · ");
            const trustBadge =
              coin.primaryTrust === "confirm_required"
                ? coin.priceSource === "cached"
                  ? "cached"
                  : coin.priceConfidence === "low"
                    ? "low conf"
                    : "verify"
                : null;

            return (
              <InteractiveTableRow
                key={coin.id}
                className={`hover:bg-muted/50 transition-colors ${accent}`}
                onActivate={() => onRowClick(coin.id)}
                onHover={() => prefetch(coin.id)}
                role="link"
              >
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground text-sm">
                  {rank}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 min-w-0">
                    <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={20} />
                    <span className="font-medium text-sm truncate">{coin.symbol}</span>
                    {trustBadge && (
                      <span
                        className="rounded-full border border-slate-300/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700 dark:border-slate-600 dark:text-slate-300"
                        title={`Primary price requires confirmation (${provenanceLabel})`}
                      >
                        {trustBadge}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground truncate hidden xl:inline">{coin.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm">
                  {coin.pegScore !== null ? (
                    <span className={pegScoreColor(coin.pegScore)}>{coin.pegScore}</span>
                  ) : (
                    <span className="text-muted-foreground">NR</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm">
                  {dews ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <DEWSBadge score={dews.score} band={dews.band as ThreatBand} signals={dews.signals} />
                      <span className="text-xs font-mono tabular-nums text-muted-foreground w-5 text-right">
                        {dews.score}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm" title={provenanceLabel}>
                  {coin.currentDeviationBps !== null ? (
                    <span className={deviationColorClass(absDev)}>
                      {coin.currentDeviationBps > 0 ? "+" : ""}{coin.currentDeviationBps} bps
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden md:table-cell">
                  {formatPercent(coin.pegPct, 1)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden md:table-cell">
                  {coin.eventCount}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden lg:table-cell">
                  {coin.worstDeviationBps !== null ? (
                    <span className={deviationColorClass(Math.abs(coin.worstDeviationBps))}>
                      {coin.worstDeviationBps > 0 ? "+" : ""}{coin.worstDeviationBps} bps
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-center hidden xl:table-cell">
                  {coin.dexPriceCheck ? (
                    coin.dexPriceCheck.agrees ? (
                      <span className="text-green-700 dark:text-green-400 text-sm" title="DEX price agrees">&#10003;</span>
                    ) : (
                      <span className="text-red-700 dark:text-red-400 text-sm" title="DEX price disagrees">&#10007;</span>
                    )
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden xl:table-cell">
                  {formatTrackingSpanDays(coin.trackingSpanDays)}
                </TableCell>
              </InteractiveTableRow>
            );
          })}
      {paginated.length === 0 && (
        <TableRow>
          <TableCell colSpan={DEPEG_TRACKER_COLUMNS.length} className="text-center py-12 text-muted-foreground">
            No depeg events detected.
          </TableCell>
        </TableRow>
      )}
    </DataTableShell>
  );
}
