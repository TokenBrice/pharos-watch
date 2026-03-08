"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortableTableHead } from "@/components/sortable-table-head";
import { TablePagination } from "@/components/table-pagination";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { formatCurrency, formatScore, formatApy } from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type { YieldRanking, AltYieldSource } from "@shared/types";

const PAGE_SIZE = 25;

type SortKey = "pys" | "apy30d" | "safetyScore" | "tvl" | "yieldStability" | "yieldType";

/** Static PYS color classes (Tailwind purge-safe). */
function getPysColor(pys: number | null): string {
  if (pys === null) return "text-muted-foreground";
  if (pys > 40) return "text-emerald-700 dark:text-emerald-400";
  if (pys > 20) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

/** Small pill badge that opens an inline popover listing alternative yield sources. */
function AltSourcesPopover({ altSources }: { altSources: AltYieldSource[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); } }}
        className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        aria-label={`${altSources.length} alternative yield source${altSources.length > 1 ? "s" : ""}`}
        aria-expanded={open}
      >
        +{altSources.length}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border bg-card shadow-lg p-2 text-xs">
          <p className="text-muted-foreground mb-1.5 font-medium">Alt sources</p>
          {altSources.map((src) => (
            <div key={src.sourceKey} className="flex items-center justify-between gap-2 py-1 border-b last:border-0">
              <span className="truncate text-foreground">{src.yieldSource}</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 shrink-0">{formatApy(src.currentApy)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface YieldLeaderboardProps {
  rankings: YieldRanking[];
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
}

export function YieldLeaderboard({ rankings, logos, onRowClick }: YieldLeaderboardProps) {
  const compareRows = useCallback(
    (a: YieldRanking, b: YieldRanking, sort: TableSortState<SortKey>): number => {
      let aVal: number;
      let bVal: number;
      switch (sort.key) {
        case "pys":
          aVal = a.pharosYieldScore ?? -1;
          bVal = b.pharosYieldScore ?? -1;
          break;
        case "apy30d":
          aVal = a.apy30d;
          bVal = b.apy30d;
          break;
        case "safetyScore":
          aVal = a.safetyScore ?? -1;
          bVal = b.safetyScore ?? -1;
          break;
        case "tvl":
          aVal = a.sourceTvlUsd ?? 0;
          bVal = b.sourceTvlUsd ?? 0;
          break;
        case "yieldStability":
          aVal = a.yieldStability ?? -1;
          bVal = b.yieldStability ?? -1;
          break;
        case "yieldType":
          return sort.direction === "asc"
            ? a.yieldType.localeCompare(b.yieldType)
            : b.yieldType.localeCompare(a.yieldType);
        default:
          aVal = a.pharosYieldScore ?? -1;
          bVal = b.pharosYieldScore ?? -1;
      }
      return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
    },
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
  } = useSortedPaginatedTable<YieldRanking, SortKey>(
    rankings,
    {
      defaultKey: "pys",
      defaultDirection: "desc",
      compareRows,
      pageSize: PAGE_SIZE,
    },
  );
  const prefetch = usePrefetchStablecoin();

  return (
    <div className="rounded-xl border overflow-x-auto scroll-shadow">
      <Table>
        <TableHeader className="bg-muted/80">
          <TableRow>
            <TableHead className="w-[50px] text-right">#</TableHead>
            <TableHead className="w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none">Coin</TableHead>
            <SortableTableHead
              sortKey="apy30d"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="APY (30d)"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
              title="30-day average annual percentage yield"
            />
            <TableHead className="hidden md:table-cell text-center" title="Pharos Safety Grade / Score">Safety</TableHead>
            <SortableTableHead
              sortKey="pys"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="PYS"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="text-right"
              title="Pharos Yield Score: risk-adjusted yield ranking"
            />
            <TableHead className="hidden sm:table-cell text-left">Source</TableHead>
            <SortableTableHead
              sortKey="yieldType"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Type"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden sm:table-cell text-center"
              title="Yield mechanism type"
            />
            <SortableTableHead
              sortKey="tvl"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="TVL"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden lg:table-cell text-right"
              title="Total value locked in yield source"
            />
            <SortableTableHead
              sortKey="yieldStability"
              currentSortKey={sortKey}
              sortDirection={sortDirection}
              label="Stability"
              toggleSort={toggleSort}
              getAriaSortValue={getAriaSortValue}
              handleSortKeyDown={handleSortKeyDown}
              className="hidden lg:table-cell text-right"
              title="Yield stability over 30 days (0-100%)"
            />
            <TableHead className="hidden xl:table-cell text-right">30d Range</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.map((row, index) => {
            const grade = row.safetyGrade;
            const safetyScore = row.safetyScore;
            return (
              <InteractiveTableRow
                key={row.id}
                onActivate={() => onRowClick(row.id)}
                onHover={() => prefetch(row.id)}
              >
                <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                  {pageStartIndex + index + 1}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[row.id]} name={row.name} size={24} />
                    <span className="font-medium">{row.symbol}</span>
                    <span className="truncate max-w-[140px] text-xs text-muted-foreground hidden xl:inline">{row.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatApy(row.apy30d)}
                </TableCell>
                <TableCell className="hidden md:table-cell text-center">
                  {grade && grade !== "NR" ? (
                    <Badge
                      variant="outline"
                      className={`text-xs font-mono px-1 py-0 ${REPORT_CARD_GRADE_COLORS[grade] ?? ""}`}
                      title={safetyScore !== null ? `${grade} (${Math.round(safetyScore)}/100)` : grade}
                    >
                      {grade}
                    </Badge>
                  ) : safetyScore !== null ? (
                    <Badge
                      variant="outline"
                      className="text-xs font-mono px-1 py-0 text-muted-foreground"
                      title={`Safety score: ${Math.round(safetyScore)}/100 (grade unavailable)`}
                    >
                      {Math.round(safetyScore)}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  <span className={getPysColor(row.pharosYieldScore)}>
                    {row.pharosYieldScore !== null ? formatScore(row.pharosYieldScore) : "--"}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-left text-sm text-muted-foreground max-w-[160px]">
                  <div className="flex items-center gap-1">
                    <span className="truncate">{row.yieldSource}</span>
                    {(row.altSources?.length ?? 0) > 0 && <AltSourcesPopover altSources={row.altSources} />}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-center">
                  <Badge
                    variant="outline"
                    className={`text-xs ${YIELD_TYPE_STYLES[row.yieldType]?.badge ?? ""}`}
                  >
                    {YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType}
                  </Badge>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right font-mono tabular-nums">
                  {row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : "--"}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right">
                  {row.yieldStability !== null ? (
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden" role="progressbar" aria-label={`Yield stability: ${Math.round(row.yieldStability * 100)}%`} aria-valuenow={Math.round(row.yieldStability * 100)} aria-valuemin={0} aria-valuemax={100}>
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${Math.min(100, Math.max(0, row.yieldStability * 100))}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono tabular-nums text-muted-foreground">
                        {Math.round(row.yieldStability * 100)}%
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TableCell>
                <TableCell className="hidden xl:table-cell text-right font-mono tabular-nums text-xs text-muted-foreground">
                  {row.apyMin30d !== null && row.apyMax30d !== null
                    ? `${row.apyMin30d.toFixed(1)}% – ${row.apyMax30d.toFixed(1)}%`
                    : "--"}
                </TableCell>
              </InteractiveTableRow>
            );
          })}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={99} className="text-center text-muted-foreground py-12">
                No yield data available
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
          noun="coins"
        />
      )}
    </div>
  );
}
