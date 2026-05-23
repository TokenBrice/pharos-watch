"use client";

import { useCallback, useMemo } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { COMMODITY_PEG_TAGS, FIAT_NON_USD_PEG_TAGS } from "@shared/lib/filter-tags";
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
  if (VALID_PEG_VALUES.has(raw as HomeAltPegFilter)) return raw as HomeAltPegFilter;
  if (COMMODITY_PEG_TAGS.includes(raw as FilterTag)) return "commodity-peg";
  if (FIAT_NON_USD_PEG_TAGS.includes(raw as FilterTag)) return "fiat-non-usd-peg";
  return "all";
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
