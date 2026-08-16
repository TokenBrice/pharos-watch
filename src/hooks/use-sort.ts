"use client";

import { useState, useCallback } from "react";
import type { SortDirection, SortState } from "@/lib/table-comparator";

export type { SortDirection, SortState } from "@/lib/table-comparator";

interface UseSortReturn<K extends string> {
  sortKey: K;
  sortDirection: SortDirection;
  toggleSort: (key: K) => void;
  getAriaSortValue: (columnKey: string) => "ascending" | "descending" | "none";
  handleSortKeyDown: (e: React.KeyboardEvent, key: K) => void;
}

export function getNextSortState<K extends string>(previous: SortState<K>, key: K): SortState<K> {
  if (previous.key === key) {
    return {
      key,
      direction: previous.direction === "asc" ? "desc" : "asc",
    };
  }
  return {
    key,
    direction: "desc",
  };
}

export function shouldToggleSortOnKeyDown(key: string): boolean {
  return key === "Enter" || key === " ";
}

export function useSort<K extends string>(defaultKey: K, defaultDir: SortDirection): UseSortReturn<K> {
  const [sortState, setSortState] = useState<SortState<K>>({
    key: defaultKey,
    direction: defaultDir,
  });

  const toggleSort = useCallback((key: K) => {
    setSortState((prev) => getNextSortState(prev, key));
  }, []);

  const sortKey = sortState.key;
  const sortDirection = sortState.direction;

  const getAriaSortValue = useCallback(
    (columnKey: string): "ascending" | "descending" | "none" => {
      if (sortKey !== columnKey) return "none";
      return sortDirection === "asc" ? "ascending" : "descending";
    },
    [sortKey, sortDirection]
  );

  const handleSortKeyDown = useCallback(
    (e: React.KeyboardEvent, key: K) => {
      if (shouldToggleSortOnKeyDown(e.key)) {
        e.preventDefault();
        toggleSort(key);
      }
    },
    [toggleSort]
  );

  return { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown };
}
