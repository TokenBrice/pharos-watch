"use client";

import { useState, useCallback } from "react";

interface UseSortReturn<K extends string> {
  sortKey: K;
  sortDirection: "asc" | "desc";
  toggleSort: (key: K) => void;
  getAriaSortValue: (columnKey: string) => "ascending" | "descending" | "none";
  handleSortKeyDown: (e: React.KeyboardEvent, key: K) => void;
}

export function useSort<K extends string>(defaultKey: K, defaultDir: "asc" | "desc"): UseSortReturn<K> {
  const [sortState, setSortState] = useState<{
    key: K;
    direction: "asc" | "desc";
  }>({
    key: defaultKey,
    direction: defaultDir,
  });

  const toggleSort = useCallback((key: K) => {
    setSortState((prev) => {
      if (prev.key === key) {
        return {
          key,
          direction: prev.direction === "asc" ? "desc" : "asc",
        };
      }
      return {
        key,
        direction: "desc",
      };
    });
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
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleSort(key);
      }
    },
    [toggleSort]
  );

  return { sortKey, sortDirection, toggleSort, getAriaSortValue, handleSortKeyDown };
}
