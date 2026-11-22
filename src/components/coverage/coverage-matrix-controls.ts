import type { CoverageFeatureKey, CoverageRow } from "@/lib/coverage";
import {
  FILTER_OPTIONS,
  SORT_OPTIONS,
  type CoverageFilterGroup,
  type CoverageFilterKey,
  type CoverageSortKey,
} from "@/lib/coverage-page-config";
import { matchesCoverageFilter, sortCoverageRows } from "@/lib/coverage-filtering";
import type { UrlStateSchema } from "@/lib/url-state";

export type ExtendedCoverageFilterKey =
  | "mica"
  | "genius"
  | "mint-authority"
  | "missing-mica"
  | "missing-genius"
  | "missing-mint-authority";

export type CoverageMatrixFilterKey = CoverageFilterKey | ExtendedCoverageFilterKey;

export type ExtendedCoverageSortKey =
  | "weakest-mica"
  | "weakest-genius"
  | "weakest-mint-authority";

export type CoverageMatrixSortKey = CoverageSortKey | ExtendedCoverageSortKey;

export interface CoverageMatrixFilterOption {
  key: CoverageMatrixFilterKey;
  label: string;
  group: CoverageFilterGroup;
}

const EXTRA_FEATURE_FILTERS: readonly CoverageMatrixFilterOption[] = [
  { key: "mica", group: "feature", label: "MiCA" },
  { key: "genius", group: "feature", label: "GENIUS" },
  { key: "mint-authority", group: "feature", label: "Mint Auth" },
];

const EXTRA_GAP_FILTERS: readonly CoverageMatrixFilterOption[] = [
  { key: "missing-mica", group: "gap", label: "No MiCA" },
  { key: "missing-genius", group: "gap", label: "No GENIUS" },
  { key: "missing-mint-authority", group: "gap", label: "No Mint Auth" },
];

export const COVERAGE_MATRIX_FILTER_OPTIONS: readonly CoverageMatrixFilterOption[] = [
  ...FILTER_OPTIONS.filter((option) => option.group === "tier"),
  ...FILTER_OPTIONS.filter((option) => option.group === "feature"),
  ...EXTRA_FEATURE_FILTERS,
  ...FILTER_OPTIONS.filter((option) => option.group === "gap"),
  ...EXTRA_GAP_FILTERS,
];

const FILTER_GROUPS: readonly CoverageFilterGroup[] = ["tier", "feature", "gap"];

export function getCoverageMatrixFilterGroups(): ReadonlyArray<ReadonlyArray<CoverageMatrixFilterOption>> {
  return FILTER_GROUPS.map((group) =>
    COVERAGE_MATRIX_FILTER_OPTIONS.filter((option) => option.group === group),
  );
}

const EXTRA_WEAKEST_SORT_OPTIONS: ReadonlyArray<{ key: ExtendedCoverageSortKey; label: string }> = [
  { key: "weakest-mica", label: "MiCA" },
  { key: "weakest-genius", label: "GENIUS" },
  { key: "weakest-mint-authority", label: "Mint Auth" },
];

export const COVERAGE_MATRIX_SORT_OPTIONS: ReadonlyArray<{
  group: string;
  options: ReadonlyArray<{
    key: CoverageMatrixSortKey;
    label: string;
  }>;
}> = SORT_OPTIONS.map((group) =>
  group.group === "Weakest Feature First"
    ? {
        ...group,
        options: [...group.options, ...EXTRA_WEAKEST_SORT_OPTIONS],
      }
    : group,
);

export interface CoverageMatrixUrlState {
  filter: CoverageMatrixFilterKey;
  sort: CoverageMatrixSortKey;
}

export const COVERAGE_MATRIX_URL_SCHEMA: UrlStateSchema<CoverageMatrixUrlState> = {
  filter: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COVERAGE_MATRIX_FILTER_OPTIONS.map((option) => option.key),
  },
  sort: {
    kind: "enum",
    defaultValue: "market-cap",
    allowedValues: COVERAGE_MATRIX_SORT_OPTIONS.flatMap((group) =>
      group.options.map((option) => option.key),
    ),
  },
};

const EXTRA_FILTER_MATCHERS: Record<ExtendedCoverageFilterKey, (row: CoverageRow) => boolean> = {
  mica: (row) => row.statuses.mica.available,
  genius: (row) => row.statuses.genius.available,
  "mint-authority": (row) => row.statuses.mintAuthority.available,
  "missing-mica": (row) =>
    row.statuses.mica.kind !== "data-unavailable" && !row.statuses.mica.available,
  "missing-genius": (row) =>
    row.statuses.genius.kind !== "data-unavailable" && !row.statuses.genius.available,
  "missing-mint-authority": (row) =>
    row.statuses.mintAuthority.kind !== "data-unavailable" && !row.statuses.mintAuthority.available,
};

const EXTRA_SORT_FEATURE_KEYS: Record<ExtendedCoverageSortKey, CoverageFeatureKey> = {
  "weakest-mica": "mica",
  "weakest-genius": "genius",
  "weakest-mint-authority": "mintAuthority",
};

function isExtendedFilterKey(filter: CoverageMatrixFilterKey): filter is ExtendedCoverageFilterKey {
  return Object.prototype.hasOwnProperty.call(EXTRA_FILTER_MATCHERS, filter);
}

function isExtendedSortKey(sort: CoverageMatrixSortKey): sort is ExtendedCoverageSortKey {
  return Object.prototype.hasOwnProperty.call(EXTRA_SORT_FEATURE_KEYS, sort);
}

export function matchesCoverageMatrixFilter(
  row: CoverageRow,
  filter: CoverageMatrixFilterKey,
): boolean {
  if (isExtendedFilterKey(filter)) {
    return EXTRA_FILTER_MATCHERS[filter](row);
  }
  return matchesCoverageFilter(row, filter);
}

export function sortCoverageMatrixRows(
  rows: CoverageRow[],
  sort: CoverageMatrixSortKey,
): CoverageRow[] {
  if (!isExtendedSortKey(sort)) {
    return sortCoverageRows(rows, sort);
  }
  const featureKey = EXTRA_SORT_FEATURE_KEYS[sort];
  return [...rows].sort((left, right) => {
    const rankDiff = left.statuses[featureKey].sortRank - right.statuses[featureKey].sortRank;
    if (rankDiff !== 0) return rankDiff;
    const headlineDiff = left.headlineCoverageCount - right.headlineCoverageCount;
    if (headlineDiff !== 0) return headlineDiff;
    return right.marketCapUsd - left.marketCapUsd;
  });
}

export function filterCoverageMatrixRows(
  rows: CoverageRow[],
  filter: CoverageMatrixFilterKey,
  sort: CoverageMatrixSortKey,
  search: string,
): CoverageRow[] {
  const normalizedSearch = search.trim().toLowerCase();
  return sortCoverageMatrixRows(
    rows.filter((row) => {
      if (!matchesCoverageMatrixFilter(row, filter)) return false;
      if (!normalizedSearch) return true;
      return (
        row.name.toLowerCase().includes(normalizedSearch) ||
        row.symbol.toLowerCase().includes(normalizedSearch)
      );
    }),
    sort,
  );
}

export function hasCoverageMatrixFilters(
  filter: CoverageMatrixFilterKey,
  search: string,
): boolean {
  return filter !== "all" || search.trim().length > 0;
}
