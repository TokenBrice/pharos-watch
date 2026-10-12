import { useCallback, useMemo } from "react";
import type { CoverageRow } from "@/lib/coverage";
import {
  FILTER_OPTIONS,
  SORT_OPTIONS,
  type CoverageFilterKey,
  type CoverageSortKey,
} from "@/lib/coverage-page-config";
import { filterCoverageRows, hasCoverageFilters } from "@/lib/coverage-filtering";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";
import { useUrlState } from "@/hooks/use-url-state";
import type { UrlStateSchema } from "@/lib/url-state";

interface CoverageUrlState {
  filter: CoverageFilterKey;
  sort: CoverageSortKey;
}

const COVERAGE_URL_SCHEMA: UrlStateSchema<CoverageUrlState> = {
  filter: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: FILTER_OPTIONS.map((option) => option.key),
  },
  sort: {
    kind: "enum",
    defaultValue: "market-cap",
    allowedValues: SORT_OPTIONS.flatMap((group) => group.options.map((option) => option.key)),
  },
};

/** Coverage matrix search (`?q=`), filter, and sort live in the URL so a filtered view is shareable. */
export function useCoverageFilters(rows: CoverageRow[]) {
  const { getParam, setParam } = useUrlFilters();
  const { state, patchState } = useUrlState(COVERAGE_URL_SCHEMA);
  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync("coverage", { getParam, setParam });
  const { filter, sort } = state;

  const setFilter = useCallback((next: CoverageFilterKey) => patchState({ filter: next }), [patchState]);
  const setSort = useCallback((next: CoverageSortKey) => patchState({ sort: next }), [patchState]);

  const filteredRows = useMemo(
    () => filterCoverageRows(rows, filter, sort, deferredSearch),
    [deferredSearch, filter, rows, sort],
  );

  const hasActiveFilters = hasCoverageFilters(filter, searchInput);

  return {
    filter,
    setFilter,
    sort,
    setSort,
    search: searchInput,
    setSearch: setSearchInput,
    filteredRows,
    hasActiveFilters,
  };
}
