import { COVERAGE_FEATURES, type CoverageFeatureKey, type CoverageRow } from "@/lib/coverage";
import type { CoverageFilterKey, CoverageSortKey } from "@/lib/coverage-page-config";

const FULL_COVERAGE_COUNT = COVERAGE_FEATURES.length;

const FILTER_MATCHERS: Record<CoverageFilterKey, (row: CoverageRow) => boolean> = {
  all: () => true,
  redemption: (row) => row.statuses.redemption.kind !== "none",
  "live-reserves": (row) => row.statuses.reserves.kind === "live",
  yield: (row) => row.statuses.yield.available,
  flows: (row) => row.statuses.flows.available,
  blacklist: (row) => row.statuses.blacklist.available,
  "weak-price": (row) => row.statuses.price.kind !== "price-only" && (row.statuses.price.sourceCount ?? 0) < 3,
  "missing-safety": (row) => !row.statuses.safety.available,
  "missing-dex": (row) => !row.statuses.dex.available,
  "missing-live-reserves": (row) => row.statuses.reserves.kind !== "live",
  "missing-flows": (row) => !row.statuses.flows.available,
  "missing-dependency": (row) => !row.statuses.dependency.available,
  "full-available": (row) => row.coverageCount === FULL_COVERAGE_COUNT,
  "full-headline": (row) => row.headlineCoverageCount === FULL_COVERAGE_COUNT,
};

const FEATURE_SORT_KEYS: Partial<Record<CoverageSortKey, CoverageFeatureKey>> = {
  "weakest-price": "price",
  "weakest-safety": "safety",
  "weakest-dex": "dex",
  "weakest-reserves": "reserves",
  "weakest-redemption": "redemption",
  "weakest-yield": "yield",
  "weakest-flows": "flows",
  "weakest-dependency": "dependency",
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
  if (sort === "least-covered") {
    return cloned.sort((left, right) => {
      if (left.coverageCount !== right.coverageCount) {
        return left.coverageCount - right.coverageCount;
      }
      if (left.headlineCoverageCount !== right.headlineCoverageCount) {
        return left.headlineCoverageCount - right.headlineCoverageCount;
      }
      return right.marketCapUsd - left.marketCapUsd;
    });
  }
  if (sort === "most-headline") {
    return cloned.sort((left, right) => {
      if (right.headlineCoverageCount !== left.headlineCoverageCount) {
        return right.headlineCoverageCount - left.headlineCoverageCount;
      }
      if (right.coverageCount !== left.coverageCount) {
        return right.coverageCount - left.coverageCount;
      }
      return right.marketCapUsd - left.marketCapUsd;
    });
  }
  if (sort === "least-headline") {
    return cloned.sort((left, right) => {
      if (left.headlineCoverageCount !== right.headlineCoverageCount) {
        return left.headlineCoverageCount - right.headlineCoverageCount;
      }
      if (left.coverageCount !== right.coverageCount) {
        return left.coverageCount - right.coverageCount;
      }
      return right.marketCapUsd - left.marketCapUsd;
    });
  }
  const featureSortKey = FEATURE_SORT_KEYS[sort];
  if (featureSortKey) {
    return cloned.sort((left, right) => {
      const leftStatus = left.statuses[featureSortKey];
      const rightStatus = right.statuses[featureSortKey];
      if (leftStatus.sortRank !== rightStatus.sortRank) {
        return leftStatus.sortRank - rightStatus.sortRank;
      }
      if (left.headlineCoverageCount !== right.headlineCoverageCount) {
        return left.headlineCoverageCount - right.headlineCoverageCount;
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
      return row.name.toLowerCase().includes(normalizedSearch) || row.symbol.toLowerCase().includes(normalizedSearch);
    }),
    sort,
  );
}

export function hasCoverageFilters(filter: CoverageFilterKey, search: string): boolean {
  return filter !== "all" || normalizeSearch(search).length > 0;
}
