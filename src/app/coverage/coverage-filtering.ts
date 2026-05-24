import { COVERAGE_FEATURES, type CoverageFeatureKey, type CoverageRow } from "@/lib/coverage";
import type { CoverageFilterKey, CoverageSortKey } from "@/lib/coverage-page-config";

const FULL_COVERAGE_COUNT = COVERAGE_FEATURES.length;

const FILTER_MATCHERS: Record<CoverageFilterKey, (row: CoverageRow) => boolean> = {
  all: () => true,
  redemption: (row) =>
    row.statuses.redemption.kind !== "none" && row.statuses.redemption.kind !== "data-unavailable",
  "live-reserves": (row) => row.statuses.reserves.kind === "live",
  yield: (row) => row.statuses.yield.available,
  flows: (row) => row.statuses.flows.available,
  blacklist: (row) => row.statuses.blacklist.kind === "live",
  "weak-price": (row) => row.statuses.price.kind !== "price-only" && (row.statuses.price.sourceCount ?? 0) < 3,
  "price-2-sources": (row) => row.statuses.price.kind !== "price-only" && row.statuses.price.sourceCount === 2,
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

type SortKeySpec = {
  key: ((row: CoverageRow) => number) | keyof CoverageRow;
  direction: "asc" | "desc";
};

function readNumeric(row: CoverageRow, key: SortKeySpec["key"]): number {
  if (typeof key === "function") return key(row);
  return row[key] as number;
}

function compareByKeys(a: CoverageRow, b: CoverageRow, specs: SortKeySpec[]): number {
  for (const spec of specs) {
    const left = readNumeric(a, spec.key);
    const right = readNumeric(b, spec.key);
    if (left !== right) {
      return spec.direction === "asc" ? left - right : right - left;
    }
  }
  return 0;
}

const MARKET_CAP_DESC: SortKeySpec = { key: "marketCapUsd", direction: "desc" };

export function sortCoverageRows(rows: CoverageRow[], sort: CoverageSortKey): CoverageRow[] {
  const cloned = [...rows];
  if (sort === "name") {
    return cloned.sort((left, right) => left.name.localeCompare(right.name));
  }
  if (sort === "most-covered") {
    return cloned.sort((left, right) =>
      compareByKeys(left, right, [
        { key: "coverageCount", direction: "desc" },
        { key: "advancedCoverageCount", direction: "desc" },
        MARKET_CAP_DESC,
      ]),
    );
  }
  if (sort === "least-covered") {
    return cloned.sort((left, right) =>
      compareByKeys(left, right, [
        { key: "coverageCount", direction: "asc" },
        { key: "headlineCoverageCount", direction: "asc" },
        MARKET_CAP_DESC,
      ]),
    );
  }
  if (sort === "most-headline") {
    return cloned.sort((left, right) =>
      compareByKeys(left, right, [
        { key: "headlineCoverageCount", direction: "desc" },
        { key: "coverageCount", direction: "desc" },
        MARKET_CAP_DESC,
      ]),
    );
  }
  if (sort === "least-headline") {
    return cloned.sort((left, right) =>
      compareByKeys(left, right, [
        { key: "headlineCoverageCount", direction: "asc" },
        { key: "coverageCount", direction: "asc" },
        MARKET_CAP_DESC,
      ]),
    );
  }
  const featureSortKey = FEATURE_SORT_KEYS[sort];
  if (featureSortKey) {
    return cloned.sort((left, right) =>
      compareByKeys(left, right, [
        { key: (row) => row.statuses[featureSortKey].sortRank, direction: "asc" },
        { key: "headlineCoverageCount", direction: "asc" },
        MARKET_CAP_DESC,
      ]),
    );
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
