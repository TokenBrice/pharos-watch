"use client";

import { useMemo } from "react";
import { useSort } from "@/hooks/use-sort";

type SortDirection = "asc" | "desc";

export interface TableSortState<K extends string> {
  key: K;
  direction: SortDirection;
}

interface UseSortedTableRowsOptions<K extends string> {
  defaultKey: K;
  defaultDirection: SortDirection;
}

interface UseSortedTableRowsReturn<T, K extends string> {
  sortKey: K;
  sortDirection: SortDirection;
  sort: TableSortState<K>;
  toggleSort: (key: K) => void;
  getAriaSortValue: (columnKey: string) => "ascending" | "descending" | "none";
  handleSortKeyDown: (e: React.KeyboardEvent, key: K) => void;
  sortedRows: T[];
}

export function sortTableRows<T, K extends string>(
  rows: readonly T[],
  sort: TableSortState<K>,
  compareRows: (a: T, b: T, sort: TableSortState<K>) => number
): T[] {
  return [...rows].sort((a, b) => compareRows(a, b, sort));
}

export function useSortedTableRows<T, K extends string>(
  rows: readonly T[],
  options: UseSortedTableRowsOptions<K>,
  compareRows: (a: T, b: T, sort: TableSortState<K>) => number
): UseSortedTableRowsReturn<T, K> {
  const { defaultKey, defaultDirection } = options;
  const { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown } = useSort<K>(
    defaultKey,
    defaultDirection
  );

  const sort = useMemo<TableSortState<K>>(
    () => ({ key: sortKey, direction: sortDirection }),
    [sortKey, sortDirection]
  );

  const sortedRows = useMemo(() => sortTableRows(rows, sort, compareRows), [rows, compareRows, sort]);

  return {
    sortKey,
    sortDirection,
    sort,
    toggleSort,
    getAriaSortValue,
    handleSortKeyDown,
    sortedRows,
  };
}
