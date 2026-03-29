"use client";

import { useState } from "react";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import type { YieldRanking } from "@shared/types";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { MethodologyLabel } from "@/components/methodology-hint";
import { YieldLeaderboardControls } from "@/components/yield-leaderboard-controls";
import { YieldLeaderboardTableRow } from "@/components/yield-leaderboard-table-row";
import { getYieldTypeLabel, matchesYieldSearch } from "@/components/yield-leaderboard-utils";

const YIELD_COLUMNS: readonly DataTableColumn<YieldTableSortKey>[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "coin", label: "Coin", className: "w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none" },
  { id: "apy30d", label: "APY (30d)", sortKey: "apy30d", className: "text-right", title: "30-day average annual percentage yield" },
  { id: "safety", label: "Safety", sortKey: "safetyScore", className: "hidden md:table-cell text-center", title: "Pharos Safety Grade / Score" },
  {
    id: "pys",
    label: <MethodologyLabel topic="pys">PYS</MethodologyLabel>,
    sortKey: "pys",
    className: "text-right",
    title: "Pharos Yield Score: risk-adjusted yield ranking",
  },
  { id: "source", label: "Source", className: "hidden sm:table-cell text-left" },
  { id: "yieldType", label: "Type", sortKey: "yieldType", className: "hidden sm:table-cell text-center", title: "Yield mechanism type" },
  { id: "tvl", label: "TVL", sortKey: "tvl", className: "hidden lg:table-cell text-right", title: "Total value locked in yield source" },
  {
    id: "yieldStability",
    label: <MethodologyLabel topic="yieldStability">Stability</MethodologyLabel>,
    sortKey: "yieldStability",
    className: "hidden lg:table-cell text-right",
    title: "Yield stability over 30 days (0-100%)",
  },
  { id: "range30d", label: "30d Range", className: "hidden xl:table-cell text-right" },
  { id: "signals", label: <MethodologyLabel topic="yieldWarnings">Signals</MethodologyLabel>, className: "hidden md:table-cell text-center" },
  { id: "sources", label: "Sources", sortKey: "sourceCount", className: "hidden md:table-cell text-center", title: "Number of yield sources tracked" },
  { id: "expand", label: <span className="sr-only">Expand row</span>, className: "w-[44px] text-right" },
] as const;

const COLUMN_COUNT = YIELD_COLUMNS.length;

interface YieldLeaderboardProps {
  rankings: YieldRanking[];
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number;
}

export function YieldLeaderboard({ rankings, logos, riskFreeRate, medianApy }: YieldLeaderboardProps) {
  const [activeLabels, setActiveLabels] = useState<Set<string>>(
    () => new Set(Object.values(YIELD_TYPE_LABELS)),
  );
  const [hideWarnings, setHideWarnings] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sheetRankingId, setSheetRankingId] = useState<string | null>(null);
  const sheetRanking = sheetRankingId ? rankings.find((r) => r.id === sheetRankingId) ?? null : null;

  const typeFiltered = rankings.filter((ranking) => activeLabels.has(getYieldTypeLabel(ranking.yieldType)));
  const warningFiltered = hideWarnings
    ? typeFiltered.filter((ranking) => ranking.warningSignals.length === 0)
    : typeFiltered;

  const searchFiltered = searchQuery.trim()
    ? warningFiltered.filter((ranking) => matchesYieldSearch(ranking, searchQuery))
    : warningFiltered;

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
  } = useSortedPaginatedTable<YieldRanking, YieldTableSortKey>(searchFiltered, {
    defaultKey: "pys",
    defaultDirection: "desc",
    compareRows: compareYieldRows,
    pageSize: TABLE_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });
  const prefetch = usePrefetchStablecoin();
  const visibleExpandedId =
    expandedId !== null && paginated.some((row) => row.id === expandedId)
      ? expandedId
      : null;

  return (
    <TooltipProvider>
      <DataTableShell
        columns={YIELD_COLUMNS}
        striped
        containerClassName="-mx-4 max-w-[calc(100%+2rem)] px-4 sm:mx-0 sm:max-w-none sm:px-0"
        sort={{
          sortKey,
          sortDirection,
          toggleSort,
          getAriaSortValue,
          handleSortKeyDown,
        }}
        topSlot={
          <YieldLeaderboardControls
            rankings={typeFiltered}
            activeLabels={activeLabels}
            hideWarnings={hideWarnings}
            searchOpen={searchOpen}
            searchQuery={searchQuery}
            onToggleLabel={(label) => {
              setActiveLabels((previous) => {
                const next = new Set(previous);
                if (next.has(label)) next.delete(label);
                else next.add(label);
                return next;
              });
            }}
            onHideWarningsChange={setHideWarnings}
            onSearchQueryChange={setSearchQuery}
            onSearchOpenChange={setSearchOpen}
            onSelectRanking={(rankingId) => {
              setSearchQuery("");
              setSearchOpen(false);
              setExpandedId(rankingId);
              requestAnimationFrame(() => {
                document.getElementById(`yield-row-${rankingId}`)?.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
              });
            }}
          />
        }
        pagination={sorted.length > 0 ? {
          page: effectivePage,
          totalPages,
          rangeStart,
          rangeEnd,
          total: totalRows,
          onPrevious: onPreviousPage,
          onNext: onNextPage,
          noun: "coins",
        } : undefined}
      >
        {paginated.map((row, index) => (
          <YieldLeaderboardTableRow
            key={row.id}
            row={row}
            index={index}
            pageStartIndex={pageStartIndex}
            logos={logos}
            riskFreeRate={riskFreeRate}
            medianApy={medianApy}
            columnCount={COLUMN_COUNT}
            expanded={visibleExpandedId === row.id}
            onPrefetch={prefetch}
            onToggleExpanded={(stablecoinId) => {
              setExpandedId((current) => (current === stablecoinId ? null : stablecoinId));
            }}
            onOpenSourceSheet={setSheetRankingId}
          />
        ))}
        {sorted.length === 0 && (
          <TableRow>
            <TableCell colSpan={COLUMN_COUNT} className="text-center text-muted-foreground py-12">
              No yield data available.
            </TableCell>
          </TableRow>
        )}
      </DataTableShell>
      <YieldSourceSheet
        ranking={sheetRanking}
        logo={sheetRankingId ? logos[sheetRankingId] : undefined}
        riskFreeRate={riskFreeRate}
        medianApy={medianApy}
        open={sheetRankingId !== null}
        onOpenChange={(open) => { if (!open) setSheetRankingId(null); }}
      />
    </TooltipProvider>
  );
}
