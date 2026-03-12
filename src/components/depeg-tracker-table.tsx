"use client";

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
import { DEWSBadge } from "@/components/dews-badge";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import { type DepegTrackerRow } from "@/lib/depeg-sort";
import type { ThreatBand } from "@shared/lib/classification";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import {
  compareDepegTrackerRows,
  rowAccentClass,
  type DepegTableSortKey,
} from "@/components/depeg-table-logic";

export type { DepegTrackerRow } from "@/lib/depeg-sort";

interface DepegTrackerTableProps {
  rows: DepegTrackerRow[];
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
}

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
    <div className="rounded-xl border overflow-x-auto scroll-shadow">
      <Table className="min-w-[420px]">
        <TableHeader className="bg-muted/80">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
            <TableHead className="w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none">Name</TableHead>
            <SortableTableHead
              sortKey="pegScore"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Peg Score"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="dewsScore"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="DEWS"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="currentDeviationBps"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Deviation"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
            />
            <SortableTableHead
              sortKey="pegPct"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Peg %"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden md:table-cell"
            />
            <SortableTableHead
              sortKey="eventCount"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Events"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden md:table-cell"
            />
            <SortableTableHead
              sortKey="worstDeviationBps"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Worst"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden lg:table-cell"
            />
            <SortableTableHead
              sortKey="dexAgrees"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="DEX Cross-check"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-center hidden xl:table-cell"
            />
            <SortableTableHead
              sortKey="trackingSpanDays"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Tracking"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right hidden xl:table-cell"
            />
          </TableRow>
        </TableHeader>
        <TableBody>
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
                  {coin.pegPct.toFixed(1)}%
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
                  {formatTrackingSpan(coin.trackingSpanDays)}
                </TableCell>
              </InteractiveTableRow>
            );
          })}
          {paginated.length === 0 && (
            <TableRow>
              <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                No depeg events detected.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <TablePagination
        page={effectivePage}
        totalPages={totalPages}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        total={totalRows}
        onPrevious={onPreviousPage}
        onNext={onNextPage}
        noun="stablecoins"
      />
    </div>
  );
}

/** Format tracking span in days to a human-readable string */
function formatTrackingSpan(days: number): string {
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30);
    return months > 0 ? `${years}y ${months}mo` : `${years}y`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return `${months}mo`;
  }
  return `${days}d`;
}
