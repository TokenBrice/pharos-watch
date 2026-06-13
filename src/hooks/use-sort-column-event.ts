"use client";

import { useEffect } from "react";
import { SORT_COLUMN_EVENT, type SortColumnEventDetail } from "@/components/providers";

interface SortColumnDef<SortKey extends string> {
  sortKey?: SortKey;
}

export function useSortColumnEvent<SortKey extends string>(
  columns: readonly SortColumnDef<SortKey>[],
  toggleSort: (sortKey: SortKey) => void,
): void {
  useEffect(() => {
    function handleSortColumn(event: Event) {
      const columnNumber = (event as CustomEvent<SortColumnEventDetail>).detail?.columnNumber;
      if (!columnNumber) return;
      const target = columns[columnNumber - 1];
      if (target?.sortKey) toggleSort(target.sortKey);
    }

    window.addEventListener(SORT_COLUMN_EVENT, handleSortColumn);
    return () => window.removeEventListener(SORT_COLUMN_EVENT, handleSortColumn);
  }, [columns, toggleSort]);
}
