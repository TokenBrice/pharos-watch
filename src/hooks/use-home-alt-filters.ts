"use client";

import { useCallback, useMemo } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { COMMODITY_PEG_TAGS, NON_USD_NON_COMMODITY_PEG_TAGS } from "@shared/lib/filter-tags";
import type { FilterTag } from "@shared/types";

export type HomeAltPegFilter = "all" | "usd-peg" | "fiat-non-usd-peg" | "commodity-peg";
export type HomeAltUniverse = "core" | "variants" | "catalog";

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
  if (NON_USD_NON_COMMODITY_PEG_TAGS.includes(raw as FilterTag)) return "fiat-non-usd-peg";
  return "all";
}

function normalizeUniverse(raw: string | null): HomeAltUniverse {
  if (raw === "variants") return "variants";
  if (raw === "catalog") return "catalog";
  return "core";
}

export interface UseHomeAltFiltersReturn {
  activePeg: HomeAltPegFilter;
  setActivePeg: (next: HomeAltPegFilter) => void;
  activeUniverse: HomeAltUniverse;
  setActiveUniverse: (next: HomeAltUniverse) => void;
  activeFilters: readonly FilterTag[];
}

export function useHomeAltFilters(): UseHomeAltFiltersReturn {
  const { searchParams, setParams } = useUrlFilters();

  const activePeg = useMemo(() => normalizePeg(searchParams.get("peg")), [searchParams]);
  const activeUniverse = useMemo(() => normalizeUniverse(searchParams.get("variant")), [searchParams]);

  const setActivePeg = useCallback(
    (next: HomeAltPegFilter) => {
      // `all` is the useUrlFilters clear sentinel for this query key.
      setParams({ peg: next });
    },
    [setParams],
  );

  const setActiveUniverse = useCallback(
    (next: HomeAltUniverse) => {
      setParams({ variant: next === "core" ? "all" : next });
    },
    [setParams],
  );

  const activeFilters = useMemo<readonly FilterTag[]>(() => (activePeg === "all" ? [] : [activePeg]), [activePeg]);

  return { activePeg, setActivePeg, activeUniverse, setActiveUniverse, activeFilters };
}
