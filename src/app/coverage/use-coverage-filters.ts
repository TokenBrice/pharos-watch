import { useDeferredValue, useMemo, useState } from "react";
import type { CoverageRow } from "@/lib/coverage";
import type { CoverageFilterKey, CoverageSortKey } from "@/lib/coverage-page-config";

const FILTER_MATCHERS: Record<CoverageFilterKey, (row: CoverageRow) => boolean> = {
  all: () => true,
  redemption: (row) => row.statuses.redemption.kind !== "none",
  "live-reserves": (row) => row.statuses.reserves.kind === "live",
  yield: (row) => row.statuses.yield.available,
  flows: (row) => row.statuses.flows.available,
  blacklist: (row) => row.statuses.blacklist.available,
};

function matchesFilter(row: CoverageRow, filter: CoverageFilterKey): boolean {
  return FILTER_MATCHERS[filter](row);
}

function sortRows(rows: CoverageRow[], sort: CoverageSortKey): CoverageRow[] {
  const cloned = [...rows];
  if (sort === "name") {
    return cloned.sort((left, right) => left.name.localeCompare(right.name));
  }
  if (sort === "most-covered") {
    return cloned.sort((left, right) => {
      if (right.coverageCount !== left.coverageCount) {
        return right.coverageCount - left.coverageCount;
      }
      if (right.advancedCoverageCount !== left.advancedCoverageCount) {
        return right.advancedCoverageCount - left.advancedCoverageCount;
      }
      return right.marketCapUsd - left.marketCapUsd;
    });
  }
  return cloned.sort((left, right) => {
    if (right.marketCapUsd !== left.marketCapUsd) {
      return right.marketCapUsd - left.marketCapUsd;
    }
    return left.name.localeCompare(right.name);
  });
}

export function useCoverageFilters(rows: CoverageRow[]) {
  const [filter, setFilter] = useState<CoverageFilterKey>("all");
  const [sort, setSort] = useState<CoverageSortKey>("market-cap");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  const filteredRows = useMemo(
    () =>
      sortRows(
        rows.filter((row) => {
          if (!matchesFilter(row, filter)) return false;
          if (!deferredSearch) return true;
          return (
            row.name.toLowerCase().includes(deferredSearch) ||
            row.symbol.toLowerCase().includes(deferredSearch)
          );
        }),
        sort,
      ),
    [deferredSearch, filter, rows, sort],
  );

  const hasActiveFilters = filter !== "all" || search.trim().length > 0;

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
