"use client";

import { useCallback, useMemo } from "react";
import type { FilterTag } from "@shared/types";
import { FILTER_GROUPS, parseHomepageParams } from "@/hooks/homepage-filter-model";
import { useUrlFilters } from "@/hooks/use-url-filters";

export { FILTER_GROUPS };

export function useHomepageFilters() {
  const { searchParams, setParams } = useUrlFilters();

  const { groupSelections, searchQuery } = useMemo(
    () => parseHomepageParams(searchParams),
    [searchParams],
  );

  const handleGroupChange = useCallback((groupLabel: string, value: string) => {
    setParams({ [groupLabel.toLowerCase()]: value });
  }, [setParams]);

  const setSearchQuery = useCallback((value: string) => {
    setParams({ q: value });
  }, [setParams]);

  const clearAll = useCallback(() => {
    const updates = Object.fromEntries(
      FILTER_GROUPS.map((group) => [group.label.toLowerCase(), "all"] as const),
    );
    setParams(updates);
  }, [setParams]);

  const activeFilters = useMemo(
    () => Object.values(groupSelections).filter((v): v is FilterTag => v !== ""),
    [groupSelections],
  );

  const hasFilters = activeFilters.length > 0;

  return {
    groupSelections,
    searchQuery,
    setSearchQuery,
    handleGroupChange,
    clearAll,
    activeFilters,
    hasFilters,
  };
}
