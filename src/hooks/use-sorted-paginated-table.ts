"use client";

import { type SortDirection } from "@/hooks/use-sort";
import { useSortedTableRows, type TableSortState } from "@/hooks/use-sorted-table-rows";
import { useTablePagination } from "@/hooks/use-table-pagination";

interface UseSortedPaginatedTableOptions<T, K extends string> {
  defaultKey: K;
  defaultDirection: SortDirection;
  compareRows: (a: T, b: T, sort: TableSortState<K>) => number;
  pageSize: number;
  resetPageOnTotalChange?: boolean;
}

export function useSortedPaginatedTable<T, K extends string>(
  rows: readonly T[],
  options: UseSortedPaginatedTableOptions<T, K>,
) {
  const {
    defaultKey,
    defaultDirection,
    compareRows,
    pageSize,
    resetPageOnTotalChange = false,
  } = options;

  const sorting = useSortedTableRows<T, K>(
    rows,
    { defaultKey, defaultDirection },
    compareRows,
  );
  const pagination = useTablePagination(sorting.sortedRows, {
    pageSize,
    resetPageOnTotalChange,
  });

  return {
    ...sorting,
    ...pagination,
  };
}
