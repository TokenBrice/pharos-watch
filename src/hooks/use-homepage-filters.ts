"use client";

import { useState, useCallback, useEffect } from "react";
import type { FilterTag } from "@/lib/types";

interface FilterGroup {
  label: string;
  options: FilterTag[];
}

export const FILTER_GROUPS: FilterGroup[] = [
  {
    label: "Peg",
    options: ["usd-peg", "gold-peg", "eur-peg", "chf-peg", "gbp-peg", "other-peg"],
  },
  {
    label: "Type",
    options: ["centralized", "centralized-dependent", "decentralized"],
  },
  {
    label: "Backing",
    options: ["rwa-backed", "crypto-backed", "algorithmic"],
  },
];

function parseHomepageSearch(search: string): {
  groupSelections: Record<string, FilterTag | "">;
  searchQuery: string;
} {
  const params = new URLSearchParams(search);
  const selections: Record<string, FilterTag | ""> = {};

  for (const group of FILTER_GROUPS) {
    const key = group.label.toLowerCase();
    const raw = params.get(key);
    if (!raw) continue;
    if (group.options.includes(raw as FilterTag)) {
      selections[group.label] = raw as FilterTag;
    }
  }

  return {
    groupSelections: selections,
    searchQuery: params.get("q") ?? "",
  };
}

export function useHomepageFilters() {
  const [groupSelections, setGroupSelections] = useState<Record<string, FilterTag | "">>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [initialized, setInitialized] = useState(false);

  const syncFromLocation = useCallback(() => {
    if (typeof window === "undefined") return;
    const parsed = parseHomepageSearch(window.location.search);
    setGroupSelections(parsed.groupSelections);
    setSearchQuery(parsed.searchQuery);
  }, []);

  useEffect(() => {
    syncFromLocation();
    setInitialized(true);
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [syncFromLocation]);

  // Sync state changes to URL
  useEffect(() => {
    if (!initialized || typeof window === "undefined") return;

    const params = new URLSearchParams();
    for (const [groupLabel, value] of Object.entries(groupSelections)) {
      if (value) {
        params.set(groupLabel.toLowerCase(), value);
      }
    }
    if (searchQuery) {
      params.set("q", searchQuery);
    }

    const qs = params.toString();
    const nextSearch = qs ? `?${qs}` : "";
    if (window.location.search === nextSearch) return;
    window.history.replaceState(null, "", `${window.location.pathname}${nextSearch}`);
  }, [groupSelections, searchQuery, initialized]);

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
