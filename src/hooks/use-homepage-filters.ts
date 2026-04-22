"use client";

import { useCallback, useMemo } from "react";
import { COMMODITY_PEG_TAGS, FIAT_NON_USD_PEG_TAGS, type FilterTag } from "@shared/types";
import { useUrlFilters } from "@/hooks/use-url-filters";

interface FilterGroup {
  label: string;
  options: FilterTag[];
}

export const FILTER_GROUPS: FilterGroup[] = [
  {
    label: "Peg",
    options: ["usd-peg", "fiat-non-usd-peg", "commodity-peg"],
  },
  {
    label: "Type",
    options: ["centralized", "centralized-dependent", "decentralized"],
  },
  {
    label: "Backing",
    options: ["rwa-backed", "crypto-backed"],
  },
  {
    label: "Grade",
    options: ["grade-a", "grade-ge-b", "grade-ge-c", "grade-le-d"],
  },
  {
    label: "Infrastructure",
    options: ["infrastructure-liquity-v1", "infrastructure-liquity-v2", "infrastructure-m0"],
  },
  {
    label: "Variant",
    options: ["variant-tracked", "variant-savings-passthrough", "variant-strategy-vault", "variant-risk-absorption"],
  },
];

function normalizeHomepagePegFilter(raw: string): FilterTag | null {
  if (raw === "usd-peg" || raw === "fiat-non-usd-peg" || raw === "commodity-peg") {
    return raw;
  }

  if (COMMODITY_PEG_TAGS.includes(raw as FilterTag)) {
    return "commodity-peg";
  }

  if (FIAT_NON_USD_PEG_TAGS.includes(raw as FilterTag)) {
    return "fiat-non-usd-peg";
  }

  return null;
}

function normalizeHomepageGradeFilter(raw: string): FilterTag | null {
  if (raw === "grade-ge-c-plus" || raw === "grade-ge-c-minus") {
    return "grade-ge-c";
  }

  if (raw === "grade-a" || raw === "grade-ge-b" || raw === "grade-ge-c" || raw === "grade-le-d") {
    return raw;
  }

  return null;
}

function normalizeHomepageVariantFilter(raw: string): FilterTag | null {
  if (raw === "variant-bond-maturity") {
    return "variant-tracked";
  }

  if (
    raw === "variant-tracked" ||
    raw === "variant-savings-passthrough" ||
    raw === "variant-strategy-vault" ||
    raw === "variant-risk-absorption"
  ) {
    return raw;
  }

  return null;
}

export function parseHomepageParams(searchParams: URLSearchParams): {
  groupSelections: Record<string, FilterTag | "">;
  searchQuery: string;
} {
  const selections: Record<string, FilterTag | ""> = {};

  for (const group of FILTER_GROUPS) {
    const key = group.label.toLowerCase();
    const raw = searchParams.get(key);
    if (!raw) continue;

    if (group.label === "Peg") {
      const normalized = normalizeHomepagePegFilter(raw);
      if (normalized) {
        selections[group.label] = normalized;
      }
      continue;
    }

    if (group.label === "Grade") {
      const normalized = normalizeHomepageGradeFilter(raw);
      if (normalized) {
        selections[group.label] = normalized;
      }
      continue;
    }

    if (group.label === "Variant") {
      const normalized = normalizeHomepageVariantFilter(raw);
      if (normalized) {
        selections[group.label] = normalized;
      }
      continue;
    }

    if (group.options.includes(raw as FilterTag)) {
      selections[group.label] = raw as FilterTag;
    }
  }

  return {
    groupSelections: selections,
    searchQuery: searchParams.get("q") ?? "",
  };
}

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
