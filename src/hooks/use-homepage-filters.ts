"use client";

import { useState, useCallback, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import type { FilterTag } from "@/lib/types";

interface FilterGroup {
  label: string;
  options: FilterTag[];
}

export const FILTER_GROUPS: FilterGroup[] = [
  {
    label: "Peg",
    options: ["usd-peg", "eur-peg", "gold-peg", "other-peg"],
  },
  {
    label: "Type",
    options: ["centralized", "centralized-dependent", "decentralized"],
  },
  {
    label: "Backing",
    options: ["rwa-backed", "crypto-backed", "algorithmic"],
  },
  {
    label: "Features",
    options: ["yield-bearing", "rwa"],
  },
];

export function useHomepageFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Initialize from URL
  const [groupSelections, setGroupSelections] = useState<Record<string, FilterTag | "">>(() => {
    const initial: Record<string, FilterTag | ""> = {};
    for (const group of FILTER_GROUPS) {
      for (const opt of group.options) {
        if (searchParams.get(group.label.toLowerCase()) === opt) {
          initial[group.label] = opt;
        }
      }
    }
    return initial;
  });
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") ?? "");

  // Sync state changes to URL
  useEffect(() => {
    const params = new URLSearchParams();
    for (const [groupLabel, value] of Object.entries(groupSelections)) {
      if (value) {
        params.set(groupLabel.toLowerCase(), value);
      }
    }
    if (searchQuery) {
      params.set("q", searchQuery);
    }
    const paramString = params.toString();
    const newUrl = paramString ? `/?${paramString}` : "/";
    router.replace(newUrl, { scroll: false });
  }, [groupSelections, searchQuery, router]);

  const handleGroupChange = useCallback((groupLabel: string, value: string) => {
    setGroupSelections((prev) => ({
      ...prev,
      [groupLabel]: value as FilterTag | "",
    }));
  }, []);

  const clearAll = useCallback(() => setGroupSelections({}), []);

  // Collect active filters (one per group that has a selection)
  const activeFilters: FilterTag[] = Object.values(groupSelections).filter(
    (v): v is FilterTag => v !== ""
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
