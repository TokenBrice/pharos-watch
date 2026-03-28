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

function normalizeSearch(search: string) {
  return search.trim().toLowerCase();
}

export function matchesCoverageFilter(row: CoverageRow, filter: CoverageFilterKey): boolean {
  return FILTER_MATCHERS[filter](row);
}

export function sortCoverageRows(rows: CoverageRow[], sort: CoverageSortKey): CoverageRow[] {
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

export function filterCoverageRows(
  rows: CoverageRow[],
  filter: CoverageFilterKey,
  sort: CoverageSortKey,
  search: string,
): CoverageRow[] {
  const normalizedSearch = normalizeSearch(search);
  return sortCoverageRows(
    rows.filter((row) => {
      if (!matchesCoverageFilter(row, filter)) return false;
      if (!normalizedSearch) return true;
      return (
        row.name.toLowerCase().includes(normalizedSearch) ||
        row.symbol.toLowerCase().includes(normalizedSearch)
      );
    }),
    sort,
  );
}

export function hasCoverageFilters(filter: CoverageFilterKey, search: string): boolean {
  return filter !== "all" || normalizeSearch(search).length > 0;
}
