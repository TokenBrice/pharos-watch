import { useDeferredValue, useMemo, useState } from "react";
import type { CoverageRow } from "@/lib/coverage";
import type { CoverageFilterKey, CoverageSortKey } from "@/lib/coverage-page-config";
import { filterCoverageRows, hasCoverageFilters } from "@/lib/coverage-filtering";

export function useCoverageFilters(rows: CoverageRow[]) {
  const [filter, setFilter] = useState<CoverageFilterKey>("all");
  const [sort, setSort] = useState<CoverageSortKey>("market-cap");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const filteredRows = useMemo(
    () => filterCoverageRows(rows, filter, sort, deferredSearch),
    [deferredSearch, filter, rows, sort],
  );

  const hasActiveFilters = hasCoverageFilters(filter, search);

  return {
    filter,
    setFilter,
    sort,
    setSort,
    search,
    setSearch,
    filteredRows,
    hasActiveFilters,
  };
}
