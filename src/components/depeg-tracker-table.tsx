"use client";

import { useMemo, useState } from "react";
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
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import { attentionScore, type DepegTrackerRow } from "@/lib/depeg-sort";
import type { ThreatBand } from "@/lib/classification";

export type { DepegTrackerRow } from "@/lib/depeg-sort";

const PAGE_SIZE = 25;

type SortKey =
  | "__attention"
  | "pegScore"
  | "dewsScore"
  | "currentDeviationBps"
  | "pegPct"
  | "eventCount"
  | "worstDeviationBps"
  | "activeDepeg"
  | "dexAgrees"
  | "trackingSpanDays";

interface DepegTrackerTableProps {
  rows: DepegTrackerRow[];
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
}

/** Row left-border class based on severity */
function rowAccentClass(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "border-l-[3px] border-l-red-500";
  const band = row.dews?.band ?? "CALM";
  if (band === "WARNING" || band === "DANGER") return "border-l-[3px] border-l-orange-500";
  return "";
}

export function DepegTrackerTable({ rows, logos, onRowClick }: DepegTrackerTableProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } =
    useSort<SortKey>("__attention", "desc");
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const [page, setPage] = useState(0);
  const prefetch = usePrefetchStablecoin();

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      // Default "attention" sort
      if (sort.key === "__attention") {
        return attentionScore(b) - attentionScore(a);
      }

      let aVal: number, bVal: number;
      switch (sort.key) {
        case "pegScore":
          aVal = a.coin.pegScore ?? -1;
          bVal = b.coin.pegScore ?? -1;
          break;
        case "dewsScore":
          aVal = a.dews?.score ?? -1;
          bVal = b.dews?.score ?? -1;
          break;
        case "currentDeviationBps":
          aVal = Math.abs(a.coin.currentDeviationBps ?? 0);
          bVal = Math.abs(b.coin.currentDeviationBps ?? 0);
          break;
        case "pegPct":
          aVal = a.coin.pegPct;
          bVal = b.coin.pegPct;
          break;
        case "eventCount":
          aVal = a.coin.eventCount;
          bVal = b.coin.eventCount;
          break;
        case "worstDeviationBps":
          aVal = Math.abs(a.coin.worstDeviationBps ?? 0);
          bVal = Math.abs(b.coin.worstDeviationBps ?? 0);
          break;
        case "activeDepeg":
          aVal = a.coin.activeDepeg ? 1 : 0;
          bVal = b.coin.activeDepeg ? 1 : 0;
          break;
        case "dexAgrees":
          aVal = a.coin.dexPriceCheck?.agrees ? 1 : 0;
          bVal = b.coin.dexPriceCheck?.agrees ? 1 : 0;
          break;
        case "trackingSpanDays":
          aVal = a.coin.trackingSpanDays;
          bVal = b.coin.trackingSpanDays;
          break;
        default:
          return attentionScore(b) - attentionScore(a);
      }
      return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [rows, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const effectivePage = page >= totalPages ? 0 : page;
  const paginated = sorted.slice(effectivePage * PAGE_SIZE, (effectivePage + 1) * PAGE_SIZE);

  return (
    <div className="rounded-xl border overflow-x-auto scroll-shadow">
      <Table>
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
              label="DEX Price Check"
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
            const rank = effectivePage * PAGE_SIZE + i + 1;

            return (
              <TableRow
                key={coin.id}
                className={`cursor-pointer hover:bg-muted/50 transition-colors ${accent}`}
                onClick={() => onRowClick(coin.id)}
                onMouseEnter={() => prefetch(coin.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(coin.id); } }}
                tabIndex={0}
                role="link"
              >
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground text-sm">
                  {rank}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 min-w-0">
                    <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={20} />
                    <span className="font-medium text-sm truncate">{coin.symbol}</span>
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
                <TableCell className="text-right">
                  {dews ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <DEWSBadge score={dews.score} band={dews.band as ThreatBand} signals={dews.signals} />
                      <span className="text-xs font-mono tabular-nums text-muted-foreground w-5 text-right">
                        {dews.score}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-sm">--</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm">
                  {coin.currentDeviationBps !== null ? (
                    <span className={deviationColorClass(absDev)}>
                      {coin.currentDeviationBps > 0 ? "+" : ""}{coin.currentDeviationBps} bps
                    </span>
                  ) : (
                    <span className="text-muted-foreground">--</span>
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
                    <span className="text-muted-foreground">--</span>
                  )}
                </TableCell>
                <TableCell className="text-center hidden xl:table-cell">
                  {coin.dexPriceCheck ? (
                    coin.dexPriceCheck.agrees ? (
                      <span className="text-green-500 text-sm" title="DEX price agrees">&#10003;</span>
                    ) : (
                      <span className="text-red-500 text-sm" title="DEX price disagrees">&#10007;</span>
                    )
                  ) : (
                    <span className="text-muted-foreground text-sm">--</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-sm hidden xl:table-cell">
                  {formatTrackingSpan(coin.trackingSpanDays)}
                </TableCell>
              </TableRow>
            );
          })}
          {paginated.length === 0 && (
            <TableRow>
              <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                No stablecoins match your filters
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <TablePagination
        page={effectivePage}
        totalPages={totalPages}
        rangeStart={sorted.length === 0 ? 0 : effectivePage * PAGE_SIZE + 1}
        rangeEnd={Math.min((effectivePage + 1) * PAGE_SIZE, sorted.length)}
        total={sorted.length}
        onPrevious={() => setPage(Math.max(0, effectivePage - 1))}
        onNext={() => setPage(Math.min(totalPages - 1, effectivePage + 1))}
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
