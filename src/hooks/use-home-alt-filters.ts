"use client";

// Peg-only filter slice for the compact homepage. Wraps the same URL machinery used by
// useHomepageFilters so the chip row and the main table stay in sync via ?peg=.

import { useCallback, useMemo } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import type { FilterTag } from "@shared/types";

export type HomeAltPegFilter = "all" | "usd-peg" | "fiat-non-usd-peg" | "commodity-peg";

const VALID_PEG_VALUES: ReadonlySet<HomeAltPegFilter> = new Set([
  "all",
  "usd-peg",
  "fiat-non-usd-peg",
  "commodity-peg",
]);

function normalizePeg(raw: string | null): HomeAltPegFilter {
  if (!raw) return "all";
  return VALID_PEG_VALUES.has(raw as HomeAltPegFilter) ? (raw as HomeAltPegFilter) : "all";
}

export interface UseHomeAltFiltersReturn {
  activePeg: HomeAltPegFilter;
  setActivePeg: (next: HomeAltPegFilter) => void;
  activeFilters: readonly FilterTag[];
}

export function useHomeAltFilters(): UseHomeAltFiltersReturn {
  const { searchParams, setParams } = useUrlFilters();

  const activePeg = useMemo(() => normalizePeg(searchParams.get("peg")), [searchParams]);

  const setActivePeg = useCallback((next: HomeAltPegFilter) => {
    setParams({ peg: next === "all" ? "all" : next });
  }, [setParams]);

  const activeFilters = useMemo<readonly FilterTag[]>(
    () => (activePeg === "all" ? [] : [activePeg]),
    [activePeg],
  );

  return { activePeg, setActivePeg, activeFilters };
}
