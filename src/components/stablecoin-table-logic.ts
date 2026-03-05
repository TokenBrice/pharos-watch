import { downloadCsv } from "@/lib/csv-export";
import type { ColumnId } from "@/hooks/use-preferences";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { DexLiquidityMap, FilterTag, PegSummaryCoin, ReportCard, StablecoinData } from "@shared/types";
import { getFilterTags, OTHER_PEG_TAGS } from "@shared/types";

export type StablecoinTableSortKey =
  | "name"
  | "price"
  | "mcap"
  | "change24h"
  | "change7d"
  | "stability"
  | "liquidity"
  | "grade"
  | "peg";

interface SortState {
  key: StablecoinTableSortKey;
  direction: "asc" | "desc";
}

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
};

export function buildTrackedIdSet(activeFilters: FilterTag[]): ReadonlySet<string> {
  if (activeFilters.length === 0) {
    return TRACKED_IDS;
  }

  return new Set(
    TRACKED_STABLECOINS.filter((stablecoin) => {
      const tags = getFilterTags(stablecoin);
      return activeFilters.every((filter) =>
        filter === "other-peg"
          ? tags.some((tag) => OTHER_PEG_TAGS.includes(tag))
          : tags.includes(filter),
      );
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

  return [...filtered].sort((a, b) => {
    let aVal: number;
    let bVal: number;

    switch (effectiveSortKey) {
      case "name":
        return sort.direction === "asc"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      case "price":
        aVal = a.price ?? 0;
        bVal = b.price ?? 0;
        break;
      case "mcap":
        aVal = getCirculatingRaw(a);
        bVal = getCirculatingRaw(b);
        break;
      case "change24h": {
        const aPrev24 = getPrevDayRaw(a);
        const bPrev24 = getPrevDayRaw(b);
        aVal = aPrev24 > 0 ? (getCirculatingRaw(a) - aPrev24) / aPrev24 : 0;
        bVal = bPrev24 > 0 ? (getCirculatingRaw(b) - bPrev24) / bPrev24 : 0;
        break;
      }
      case "change7d": {
        const aPrev7 = getPrevWeekRaw(a);
        const bPrev7 = getPrevWeekRaw(b);
        aVal = aPrev7 > 0 ? (getCirculatingRaw(a) - aPrev7) / aPrev7 : 0;
        bVal = bPrev7 > 0 ? (getCirculatingRaw(b) - bPrev7) / bPrev7 : 0;
        break;
      }
      case "stability": {
        const aScore = pegScores?.get(a.id)?.pegScore ?? null;
        const bScore = pegScores?.get(b.id)?.pegScore ?? null;
        if (aScore === null && bScore === null) return 0;
        if (aScore === null) return 1;
        if (bScore === null) return -1;
        aVal = aScore;
        bVal = bScore;
        break;
      }
      case "liquidity": {
        const aScore = dexLiquidity?.[a.id]?.liquidityScore ?? null;
        const bScore = dexLiquidity?.[b.id]?.liquidityScore ?? null;
        if (aScore === null && bScore === null) return 0;
        if (aScore === null) return 1;
        if (bScore === null) return -1;
        aVal = aScore;
        bVal = bScore;
        break;
      }
      case "grade": {
        const aScore = reportCards?.[a.id]?.overallScore ?? null;
        const bScore = reportCards?.[b.id]?.overallScore ?? null;
        if (aScore === null && bScore === null) return 0;
        if (aScore === null) return 1;
        if (bScore === null) return -1;
        aVal = aScore;
        bVal = bScore;
        break;
      }
      case "peg": {
        const getAbsBps = (coin: StablecoinData) => {
          const meta = metaById.get(coin.id);
          if (meta?.flags.navToken) return null;
          const ref = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
          const price = coin.price;
          return price != null && ref > 0 ? Math.abs(price / ref - 1) * 10_000 : null;
        };
        const aDev = getAbsBps(a);
        const bDev = getAbsBps(b);
        if (aDev === null && bDev === null) return 0;
        if (aDev === null) return 1;
        if (bDev === null) return -1;
        aVal = aDev;
        bVal = bDev;
        break;
      }
      default:
        aVal = getCirculatingRaw(a);
        bVal = getCirculatingRaw(b);
    }

    return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
  });
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
      { header: "Grade", accessor: (row) => reportCards?.[row.id]?.overallGrade ?? null },
    ],
    "pharos-stablecoins",
  );
}
