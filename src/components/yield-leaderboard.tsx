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
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SortableTableHead } from "@/components/sortable-table-head";
import { TablePagination } from "@/components/table-pagination";
import { useSort } from "@/hooks/use-sort";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { formatCurrency } from "@/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@/lib/report-cards";
import { YIELD_TYPE_LABELS, YIELD_TYPE_STYLES } from "@/lib/classification";
import type { YieldRanking } from "@/lib/types";

const PAGE_SIZE = 25;

type SortKey = "pys" | "apy30d" | "safetyScore" | "tvl" | "yieldStability" | "yieldType";

/** Static PYS color classes (Tailwind purge-safe). */
function getPysColor(pys: number | null): string {
  if (pys === null) return "text-muted-foreground";
  if (pys > 40) return "text-emerald-500";
  if (pys > 20) return "text-amber-500";
  return "text-red-500";
}

interface YieldLeaderboardProps {
  rankings: YieldRanking[];
  logos: Record<string, string> | undefined;
  onRowClick: (id: string) => void;
}

export function YieldLeaderboard({ rankings, logos, onRowClick }: YieldLeaderboardProps) {
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<SortKey>("pys", "desc");
  const sort = useMemo(() => ({ key: sortKey, direction: sortDirection }), [sortKey, sortDirection]);
  const [page, setPage] = useState(0);
  const prefetch = usePrefetchStablecoin();

  const sorted = useMemo(() => {
    return [...rankings].sort((a, b) => {
      let aVal: number, bVal: number;
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
    });
  }, [rankings, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const effectivePage = page >= totalPages ? 0 : page;
  const paginated = sorted.slice(effectivePage * PAGE_SIZE, (effectivePage + 1) * PAGE_SIZE);

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
              <TableRow
                key={row.id}
                className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                onClick={() => onRowClick(row.id)}
                onMouseEnter={() => prefetch(row.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row.id); } }}
                tabIndex={0}
              >
                <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                  {effectivePage * PAGE_SIZE + index + 1}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[row.id]} name={row.name} size={24} />
                    <span className="font-medium">{row.symbol}</span>
                    <span className="truncate max-w-[140px] text-xs text-muted-foreground hidden xl:inline">{row.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {row.apy30d.toFixed(2)}%
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
                    {row.pharosYieldScore !== null ? row.pharosYieldScore.toFixed(1) : "--"}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-left text-sm text-muted-foreground truncate max-w-[160px]">
                  {row.yieldSource}
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
              </TableRow>
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
          rangeStart={sorted.length === 0 ? 0 : effectivePage * PAGE_SIZE + 1}
          rangeEnd={Math.min((effectivePage + 1) * PAGE_SIZE, sorted.length)}
          total={sorted.length}
          onPrevious={() => setPage(Math.max(0, effectivePage - 1))}
          onNext={() => setPage(Math.min(totalPages - 1, effectivePage + 1))}
          noun="coins"
        />
      )}
    </div>
  );
}
