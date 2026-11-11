"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSortedPaginatedTable } from "@/hooks/use-sorted-paginated-table";
import { compareYieldRows, type YieldTableSortKey } from "@/components/yield-table-logic";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

function scrollToVisibleRow(id: string) {
  const row = Array.from(document.querySelectorAll<HTMLElement>("[data-yield-row-display]"))
    .find((element) => element.dataset.yieldRowDisplay === id && element.getClientRects().length > 0);
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function useYieldLeaderboardController(rows: readonly YieldViewModelRow[]) {
  const table = useSortedPaginatedTable<YieldViewModelRow, YieldTableSortKey>(rows, {
    defaultKey: "pys",
    defaultDirection: "desc",
    compareRows: compareYieldRows,
    pageSize: TABLE_PAGE_SIZE,
    resetPageOnTotalChange: true,
  });
  const pendingRevealId = useRef<string | null>(null);
  const { sortedRows, effectivePage, onPageChange } = table;

  useEffect(() => {
    if (pendingRevealId.current === null) return;
    scrollToVisibleRow(pendingRevealId.current);
    pendingRevealId.current = null;
  }, [effectivePage]);

  const revealRow = useCallback((id: string) => {
    const index = sortedRows.findIndex((row) => row.id === id);
    if (index < 0) return;
    const page = Math.floor(index / TABLE_PAGE_SIZE);
    pendingRevealId.current = null;
    if (page === effectivePage) {
      scrollToVisibleRow(id);
    } else {
      pendingRevealId.current = id;
      onPageChange(page);
    }
  }, [effectivePage, onPageChange, sortedRows]);

  return { ...table, revealRow };
}
