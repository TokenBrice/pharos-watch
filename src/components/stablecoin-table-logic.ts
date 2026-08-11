import { downloadCsv } from "@/lib/exports/csv";
import { createTableComparator } from "@/lib/table-comparator";
import { resolveMintAuthorityScoreDisplay, resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import type { ColumnId } from "@/hooks/use-preferences";
import { GRADE_FILTER_TAGS, getFilterTags, gradeMatchesFilter, OTHER_PEG_TAGS } from "@shared/lib/filter-tags";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import {
  CLIENT_ACTIVE_IDS as ACTIVE_IDS,
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityMap, FilterTag, PegSummaryCoin, StablecoinData } from "@shared/types";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";

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
  | "blacklistable"
  | "mintAuthority";

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
  mintAuthority: "mintAuthority",
};

export function prioritizePinnedStablecoins(
  rows: readonly StablecoinData[],
  pinnedStablecoinIds: readonly string[],
): StablecoinData[] {
  if (rows.length === 0 || pinnedStablecoinIds.length === 0) {
    return [...rows];
  }

  const pinnedOrder = new Map(pinnedStablecoinIds.map((id, index) => [id, index]));
  const pinned: StablecoinData[] = [];
  const unpinned: StablecoinData[] = [];

  for (const row of rows) {
    if (pinnedOrder.has(row.id)) {
      pinned.push(row);
    } else {
      unpinned.push(row);
    }
  }

  pinned.sort((a, b) => (pinnedOrder.get(a.id) ?? 0) - (pinnedOrder.get(b.id) ?? 0));
  return [...pinned, ...unpinned];
}

export function buildTrackedIdSet(
  activeFilters: readonly FilterTag[],
  reportCards?: Record<string, V9SafetyTableRow>,
  eligibleIds: ReadonlySet<string> = ACTIVE_IDS,
): ReadonlySet<string> {
  if (activeFilters.length === 0) {
    return eligibleIds;
  }

  // Separate grade filters from regular filters
  const regularFilters = activeFilters.filter((f) => !GRADE_FILTER_TAGS.includes(f));
  const gradeFilters = activeFilters.filter((f) => GRADE_FILTER_TAGS.includes(f));

  return new Set(
    ACTIVE_STABLECOINS.filter((stablecoin) => {
      if (!eligibleIds.has(stablecoin.id)) return false;
      // Check regular filters (from metadata tags)
      const tags = getFilterTags(stablecoin);
      const regularMatch = regularFilters.every((filter) =>
        filter === "other-peg" ? tags.some((tag) => OTHER_PEG_TAGS.includes(tag)) : tags.includes(filter),
      );
      if (!regularMatch) return false;

      // Check grade filters (from reportCards)
      if (gradeFilters.length > 0) {
        const grade = reportCards?.[stablecoin.id]?.grade;
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
  reportCards?: Record<string, V9SafetyTableRow>,
): StablecoinTableRowRiskLevel {
  const pegCoin = pegScores?.get(coin.id);
  const reportCard = reportCards?.[coin.id];

  if (pegCoin?.pegScore !== null && pegCoin?.pegScore !== undefined && pegCoin.pegScore < 60) {
    return "depeg";
  }
  if (reportCard?.grade && ["D", "F"].includes(reportCard.grade)) {
    return "poor";
  }
  if (reportCard?.grade === "C") {
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
  reportCards?: Record<string, V9SafetyTableRow>;
}

type StablecoinSortValue = number | string | null | undefined;

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

  const extractors: Record<StablecoinTableSortKey, (row: StablecoinData) => StablecoinSortValue> = {
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
    grade: (r) => reportCards?.[r.id]?.score ?? null,
    blacklistable: (r) => {
      const status = getResolvedBlacklistStatus(r.id);
      if (status === null) return null;
      if (status === true) return 3;
      if (status === "possible" || status === "inherited") return 1;
      return 0;
    },
    mintAuthority: (r) => resolveMintAuthorityScoreDisplay(reportCards?.[r.id]?.mint).score,
    peg: (r) => {
      const meta = metaById.get(r.id);
      if (meta?.flags.navToken) return null;
      const ref = getPegReference(r.pegType, pegRates, meta?.commodityOunces);
      const price = r.price;
      return price != null && ref > 0 ? Math.abs(price / ref - 1) * 10_000 : null;
    },
  };
  const extractSortValue = extractors[effectiveSortKey];
  const compare = createTableComparator<"value", { value: StablecoinSortValue; index: number }>({
    value: (r) => r.value,
  });

  return filtered
    .map((row, index) => ({ row, index, value: extractSortValue(row) }))
    .sort((a, b) => {
      const compared = compare(a, b, { key: "value", direction: sort.direction });
      return compared || a.index - b.index;
    })
    .map(({ row }) => row);
}

export function exportStablecoinsCsv(
  sorted: StablecoinData[],
  pegScores?: Map<string, PegSummaryCoin>,
  dexLiquidity?: DexLiquidityMap,
  reportCards?: Record<string, V9SafetyTableRow>,
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
          const status = getResolvedBlacklistStatus(row.id);
          return status === true ? "Yes" : status === "inherited" ? "Upstream" : status === "possible" ? "Possible" : status === false ? "No" : "Unknown";
        },
      },
      {
        header: "Mint Authority Status",
        accessor: (row) => {
          const meta = TRACKED_META_BY_ID.get(row.id);
          return resolveMintAuthorityStatus(meta?.mintAuthoritySummary).spokenLabel;
        },
      },
      {
        header: "Mint Control Score",
        accessor: (row) => resolveMintAuthorityScoreDisplay(reportCards?.[row.id]?.mint).score ?? null,
      },
      {
        header: "Mint Control Band",
        accessor: (row) => resolveMintAuthorityScoreDisplay(reportCards?.[row.id]?.mint).bandLabel,
      },
      { header: "Grade", accessor: (row) => reportCards?.[row.id]?.grade ?? null },
    ],
    "pharos-stablecoins",
  );
}
