"use client";

import { useCallback, useMemo, useState } from "react";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import {
  DataTableEmptyRow,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { YieldLeaderboardTableRow } from "@/components/yield-leaderboard-table-row";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

const YIELD_COLUMNS: readonly DataTableColumn<YieldTableSortKey>[] = [
  { id: "coin", label: "Coin", className: "hidden md:table-cell w-[70px] xl:w-[200px] max-w-[70px] xl:max-w-none" },
  { id: "apy30d", label: "APY (30d)", sortKey: "apy30d", className: "hidden md:table-cell text-right", title: "30-day average annual percentage yield" },
  { id: "safety", label: "Safety", sortKey: "safetyScore", className: "hidden md:table-cell text-center", title: "Pharos Safety Grade / Score" },
  {
    id: "pys",
    label: "PYS",
    headerAdornment: <MethodologyHint topic="pys" />,
    sortKey: "pys",
    className: "hidden md:table-cell text-right",
    title: "Pharos Yield Score: risk-adjusted yield ranking",
  },
  { id: "source", label: "Source", className: "hidden md:table-cell text-left" },
  { id: "yieldType", label: "Type", sortKey: "yieldType", className: "hidden md:table-cell text-center", title: "Yield mechanism type" },
  { id: "tvl", label: "TVL", sortKey: "tvl", className: "hidden lg:table-cell text-right", title: "Total value locked in yield source" },
  {
    id: "yieldStability",
    label: "Stability",
    headerAdornment: <MethodologyHint topic="yieldStability" />,
    sortKey: "yieldStability",
    className: "hidden lg:table-cell text-right",
    title: "Yield stability over 30 days (0-100%)",
  },
  { id: "range30d", label: "30d Range", className: "hidden xl:table-cell text-right" },
  { id: "signals", label: <MethodologyLabel topic="yieldWarnings">Signals</MethodologyLabel>, className: "hidden md:table-cell text-center" },
  { id: "expand", label: <span className="sr-only">Expand row</span>, className: "hidden md:table-cell w-[44px] text-right" },
] as const;

const COLUMN_COUNT = YIELD_COLUMNS.length;

interface YieldLeaderboardProps {
  rows: YieldViewModelRow[];
  logos: Record<string, string>;
  riskFreeRate: number;
  medianApy: number;
  emptyMessage?: string;
}

export function YieldLeaderboard({ rows, logos, riskFreeRate, medianApy, emptyMessage }: YieldLeaderboardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sheetRankingId, setSheetRankingId] = useState<string | null>(null);
  const sheetRanking = useMemo(
    () => (sheetRankingId ? rows.find((r) => r.id === sheetRankingId) ?? null : null),
    [rows, sheetRankingId],
  );

  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    sortedRows: sorted,
    effectivePage,
    totalPages,
    paginatedRows: paginated,
    rangeStart,
    rangeEnd,
    totalRows,
    onPreviousPage,
    onNextPage,
  } = useSortedPaginatedTable<YieldViewModelRow, YieldTableSortKey>(rows, {
    defaultKey: "pys",
    defaultDirection: "desc",
    compareRows: compareYieldRows,
    pageSize: TABLE_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });
  const prefetch = usePrefetchStablecoin();
  const visibleExpandedId = useMemo(
    () => (expandedId !== null && paginated.some((row) => row.id === expandedId) ? expandedId : null),
    [expandedId, paginated],
  );
  const handleToggleExpanded = useCallback((stablecoinId: string) => {
    setExpandedId((current) => (current === stablecoinId ? null : stablecoinId));
  }, []);

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
        }}
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
        {paginated.map((row) => (
          <YieldLeaderboardTableRow
            key={row.id}
            row={row}
            logos={logos}
            riskFreeRate={riskFreeRate}
            medianApy={medianApy}
            columnCount={COLUMN_COUNT}
            expanded={visibleExpandedId === row.id}
            onPrefetch={prefetch}
            onToggleExpanded={handleToggleExpanded}
            onOpenSourceSheet={setSheetRankingId}
          />
        ))}
        {sorted.length === 0 && (
          <DataTableEmptyRow colSpan={COLUMN_COUNT}>
            {emptyMessage ?? "No yield data available."}
          </DataTableEmptyRow>
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
