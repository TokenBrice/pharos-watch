import { downloadCsv } from "@/lib/csv-export";
import { createTableComparator } from "@/lib/table-comparator";
import { getResolvedBlacklistStatus, getResolvedBlacklistStatusLabel } from "@/lib/blacklist-status";
import type { ColumnId } from "@/hooks/use-preferences";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { ACTIVE_IDS, TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { DexLiquidityMap, FilterTag, PegSummaryCoin, ReportCard, StablecoinData } from "@shared/types";
import { getFilterTags, OTHER_PEG_TAGS, GRADE_FILTER_TAGS, gradeMatchesFilter } from "@shared/types";

export type StablecoinTableSortKey =
  | "name"
  | "price"
  | "mcap"
  | "change24h"
  | "change7d"
  | "stability"
  | "liquidity"
  | "grade"
  | "peg"
  | "blacklistable";

interface SortState {
  key: StablecoinTableSortKey;
  direction: "asc" | "desc";
}

export type StablecoinTableRowRiskLevel = "depeg" | "poor" | "warning" | "normal";

const SORT_KEY_TO_COLUMN: Record<StablecoinTableSortKey, ColumnId> = {
  name: "name",
  price: "price",
  mcap: "mcap",
  change24h: "change24h",
  change7d: "change7d",
  stability: "stability",
  liquidity: "liquidity",
  grade: "grade",
  peg: "peg",
  blacklistable: "blacklistable",
};

export function buildTrackedIdSet(
  activeFilters: FilterTag[],
  reportCards?: Record<string, ReportCard>,
): ReadonlySet<string> {
  if (activeFilters.length === 0) {
    return ACTIVE_IDS;
  }

  // Separate grade filters from regular filters
  const regularFilters = activeFilters.filter((f) => !GRADE_FILTER_TAGS.includes(f));
  const gradeFilters = activeFilters.filter((f) => GRADE_FILTER_TAGS.includes(f));

  return new Set(
    ACTIVE_STABLECOINS.filter((stablecoin) => {
      // Check regular filters (from metadata tags)
      const tags = getFilterTags(stablecoin);
      const regularMatch = regularFilters.every((filter) =>
        filter === "other-peg"
          ? tags.some((tag) => OTHER_PEG_TAGS.includes(tag))
          : tags.includes(filter),
      );
      if (!regularMatch) return false;

      // Check grade filters (from reportCards)
      if (gradeFilters.length > 0) {
        const grade = reportCards?.[stablecoin.id]?.overallGrade;
        const gradeMatch = gradeFilters.every((filter) => gradeMatchesFilter(grade, filter));
        if (!gradeMatch) return false;
      }

      return true;
    }).map((stablecoin) => stablecoin.id),
  );
}

export function filterStablecoins(
  data: StablecoinData[] | undefined,
  trackedIds: ReadonlySet<string>,
  searchQuery: string | undefined,
): StablecoinData[] {
  if (!data) return [];
  const query = searchQuery?.toLowerCase().trim() ?? "";

  return data.filter((coin) => {
    if (!trackedIds.has(coin.id)) return false;
    if (query && !coin.name.toLowerCase().includes(query) && !coin.symbol.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function resolveEffectiveSortKey(
  sortKey: StablecoinTableSortKey,
  visibleColumns: ReadonlySet<ColumnId>,
): StablecoinTableSortKey {
  const columnId = SORT_KEY_TO_COLUMN[sortKey];
  return visibleColumns.has(columnId) ? sortKey : "mcap";
}

export function getStablecoinTableRowRiskLevel(
  coin: StablecoinData,
  pegScores?: Map<string, PegSummaryCoin>,
  reportCards?: Record<string, ReportCard>,
): StablecoinTableRowRiskLevel {
  const pegCoin = pegScores?.get(coin.id);
  const reportCard = reportCards?.[coin.id];

  if (pegCoin?.pegScore !== null && pegCoin?.pegScore !== undefined && pegCoin.pegScore < 60) {
    return "depeg";
  }
  if (reportCard?.overallGrade && ["D", "F"].includes(reportCard.overallGrade)) {
    return "poor";
  }
  if (reportCard?.overallGrade === "C") {
    return "warning";
  }
  return "normal";
}

interface SortStablecoinsParams {
  filtered: StablecoinData[];
  sort: SortState;
  effectiveSortKey: StablecoinTableSortKey;
  pegRates: Record<string, number>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, ReportCard>;
}

export function sortStablecoins({
  filtered,
  sort,
  effectiveSortKey,
  pegRates,
  pegScores,
  dexLiquidity,
  reportCards,
}: SortStablecoinsParams): StablecoinData[] {
  const metaById = TRACKED_META_BY_ID;

  const compare = createTableComparator<StablecoinTableSortKey, StablecoinData>({
    name: (r) => r.name.toLowerCase(),
    price: (r) => r.price ?? 0,
    mcap: (r) => getCirculatingRaw(r),
    change24h: (r) => {
      const prev = getPrevDayRaw(r);
      return prev > 0 ? (getCirculatingRaw(r) - prev) / prev : 0;
    },
    change7d: (r) => {
      const prev = getPrevWeekRaw(r);
      return prev > 0 ? (getCirculatingRaw(r) - prev) / prev : 0;
    },
    stability: (r) => pegScores?.get(r.id)?.pegScore ?? null,
    liquidity: (r) => dexLiquidity?.[r.id]?.liquidityScore ?? null,
    grade: (r) => reportCards?.[r.id]?.overallScore ?? null,
    blacklistable: (r) => {
      const status = getResolvedBlacklistStatus(r.id, reportCards?.[r.id]);
      if (status === null) return null;
      if (status === true) return 2;
      if (status === "possible" || status === "inherited") return 1;
      return 0;
    },
    peg: (r) => {
      const meta = metaById.get(r.id);
      if (meta?.flags.navToken) return null;
      const ref = getPegReference(r.pegType, pegRates, meta?.commodityOunces);
      const price = r.price;
      return price != null && ref > 0 ? Math.abs(price / ref - 1) * 10_000 : null;
    },
  });

  return [...filtered].sort((a, b) =>
    compare(a, b, { key: effectiveSortKey, direction: sort.direction }),
  );
}

export function exportStablecoinsCsv(
  sorted: StablecoinData[],
  pegScores?: Map<string, PegSummaryCoin>,
  dexLiquidity?: DexLiquidityMap,
  reportCards?: Record<string, ReportCard>,
): void {
  downloadCsv(
    sorted,
    [
      { header: "Rank", accessor: (_row, i) => i + 1 },
      { header: "Name", accessor: (row) => row.name },
      { header: "Symbol", accessor: (row) => row.symbol },
      { header: "Price", accessor: (row) => row.price ?? null },
      { header: "Market Cap (USD)", accessor: (row) => getCirculatingRaw(row) },
      {
        header: "24h Change (%)",
        accessor: (row) => {
          const prev = getPrevDayRaw(row);
          if (prev <= 0) return null;
          return Number((((getCirculatingRaw(row) - prev) / prev) * 100).toFixed(2));
        },
      },
      {
        header: "7d Change (%)",
        accessor: (row) => {
          const prev = getPrevWeekRaw(row);
          if (prev <= 0) return null;
          return Number((((getCirculatingRaw(row) - prev) / prev) * 100).toFixed(2));
        },
      },
      { header: "Peg Score", accessor: (row) => pegScores?.get(row.id)?.pegScore ?? null },
      { header: "Liquidity Score", accessor: (row) => dexLiquidity?.[row.id]?.liquidityScore ?? null },
      {
        header: "Blacklistable",
        accessor: (row) => {
          if (!TRACKED_META_BY_ID.has(row.id)) return null;
          return getResolvedBlacklistStatusLabel(row.id, reportCards?.[row.id]);
        },
      },
      { header: "Grade", accessor: (row) => reportCards?.[row.id]?.overallGrade ?? null },
    ],
    "pharos-stablecoins",
  );
}
