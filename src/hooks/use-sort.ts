import { useState, useCallback } from "react";

interface UseSortReturn<K extends string> {
  sortKey: K;
  sortDirection: "asc" | "desc";
  toggleSort: (key: K) => void;
  getAriaSortValue: (columnKey: string) => "ascending" | "descending" | "none";
  handleSortKeyDown: (e: React.KeyboardEvent, key: K) => void;
}

export function useSort<K extends string>(defaultKey: K, defaultDir: "asc" | "desc"): UseSortReturn<K> {
  const [sortKey, setSortKey] = useState<K>(defaultKey);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">(defaultDir);

  const toggleSort = useCallback((key: K) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      setSortDirection("desc");
      return key;
    });
  }, []);

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
