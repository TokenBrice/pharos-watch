import { downloadCsvWithPreamble } from "@/lib/exports/csv";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { hasObservedDisplayPrice, hasPublishedDeviation, resolveCurrentDeviation, resolveCurrentDeviationBps, resolveDisplayPegReference } from "@/lib/current-peg";
import { createTableComparator } from "@/lib/table-comparator";
import { getReportCardGradeRank } from "@shared/lib/report-card-core";
import { resolveMintAuthorityScoreDisplay, resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import { getQuoteMatchedNavPriceReference } from "@/lib/nav-price-reference";
import type { ColumnId } from "@/hooks/use-preferences";
import { GRADE_FILTER_TAGS, getFilterTags, gradeMatchesFilter } from "@shared/lib/filter-tags";
import { pegCurrencySymbol } from "@shared/lib/peg-format";
import { getPegTaxonomyByCurrency } from "@shared/lib/peg-taxonomy";
import { getCirculatingRawOrNull, getUsdMarketCapBaselineOrNull } from "@shared/lib/supply";
import { buildSupplyObservationProvenance, isSupplyWindowComparable } from "@shared/lib/supply-provenance";
import {
  CLIENT_ACTIVE_IDS as ACTIVE_IDS,
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityTableMap } from "@shared/types/dex-liquidity";
import type { FilterTag } from "@shared/types/stablecoin-meta-primitives";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinData } from "@shared/types/supply";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";

export type StablecoinTableSourceGenerations = Partial<Record<"stablecoins" | "pegSummary" | "dexLiquidity" | "reportCards", number | null>>;

function generationIso(timestamp: number | null | undefined): string | null {
  return timestamp != null && Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

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

export interface DisplayedNativePrice {
  /** Unrounded price in the unit the cell displays. */
  value: number | null;
  /** Currency the cell prints. */
  currency: string;
  /** Reference used for the conversion; null when the cell prints the USD quote. */
  reference: number | null;
}

/**
 * Share the Price column's visibility and unit between the cell and the sort.
 */
export function resolveDisplayedNativePrice(
  coin: StablecoinData,
  pegSummary: PegSummaryCoin | undefined,
  pegScores?: Map<string, PegSummaryCoin>,
): DisplayedNativePrice | null {
  if (!isObservedPrice(coin)) return null;
  const meta = TRACKED_META_BY_ID.get(coin.id);
  const currency = meta?.flags.pegCurrency ?? "USD";
  const reference = meta?.flags.navToken
    ? getQuoteMatchedNavPriceReference(currency, coin.priceObservedAt, pegScores)
    : resolveDisplayPegReference(coin, pegSummary, currency);
  const usesUsdSymbol = getPegTaxonomyByCurrency(currency)?.nativePriceUsesUsdSymbol === true;
  if (reference == null && !meta?.flags.navToken && pegCurrencySymbol(currency) !== "$"
    && !resolveCurrentDeviation(coin, pegSummary, meta?.flags.pegCurrency).referenceNote
    && (hasPublishedDeviation(coin.currentPeg) || !hasPublishedDeviation(pegSummary))) return null;

  const price = hasObservedDisplayPrice(coin) ? coin.price : null;
  const value = price != null && !usesUsdSymbol && reference != null ? price / reference : price;
  return {
    value: Number.isFinite(value) ? value : null,
    currency: usesUsdSymbol || reference == null ? "USD" : currency,
    reference,
  };
}

export function getSupplyChangeBaseline(coin: StablecoinData, window: "day" | "week" | "month") {
  return coin.supplyChangeBaselines?.[window];
}

export function getMarketCapBaseline(coin: StablecoinData, window: "day" | "week" | "month"): number | null {
  if (coin.supplyRestored === true || !isSupplyWindowComparable(buildSupplyObservationProvenance(coin), window)) return null;
  return getUsdMarketCapBaselineOrNull(coin, window);
}

export function getSupplyChangePercent(
  coin: StablecoinData,
  window: "day" | "week" | "month" | number | null,
): number | null {
  if (window !== "day" && window !== "week" && window !== "month") return null;
  const current = getCirculatingRawOrNull(coin);
  const previous = getMarketCapBaseline(coin, window);
  if (current == null || previous == null || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export function usesLegacyChangeWindow(rows: readonly StablecoinData[], window: "day" | "week"): boolean {
  return rows.some((coin) => coin.supplyChangeBaselines?.[window] === undefined && getSupplyChangePercent(coin, window) != null);
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

  const regularFilters = activeFilters.filter((f) => !GRADE_FILTER_TAGS.includes(f));
  const gradeFilters = activeFilters.filter((f) => GRADE_FILTER_TAGS.includes(f));

  return new Set(
    ACTIVE_STABLECOINS.filter((stablecoin) => {
      if (!eligibleIds.has(stablecoin.id)) return false;
      const tags = getFilterTags(stablecoin);
      const regularMatch = regularFilters.every((filter) => tags.includes(filter));
      if (!regularMatch) return false;

      if (gradeFilters.length > 0) {
        const grade = reportCards?.[stablecoin.id]?.grade;
        const gradeMatch = grade != null && gradeFilters.every((filter) => gradeMatchesFilter(grade, filter));
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
  gradeInRowSummary = false,
): StablecoinTableSortKey {
  const columnId = SORT_KEY_TO_COLUMN[sortKey];
  // The phone row's risk summary prints the grade, so a grade order stays legible without its column.
  return visibleColumns.has(columnId) || (gradeInRowSummary && sortKey === "grade") ? sortKey : "mcap";
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
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityTableMap;
  reportCards?: Record<string, V9SafetyTableRow>;
}

type StablecoinSortValue = number | string | null | undefined;

export function sortStablecoins({
  filtered,
  sort,
  effectiveSortKey,
  pegScores,
  dexLiquidity,
  reportCards,
}: SortStablecoinsParams): StablecoinData[] {
  const extractors: Record<StablecoinTableSortKey, (row: StablecoinData) => StablecoinSortValue> = {
    name: (r) => r.name.toLowerCase(),
    price: (r) => resolveDisplayedNativePrice(r, pegScores?.get(r.id), pegScores)?.value ?? null,
    mcap: (r) => getCirculatingRawOrNull(r),
    change24h: (r) => getSupplyChangePercent(r, "day"),
    change7d: (r) => getSupplyChangePercent(r, "week"),
    stability: (r) => pegScores?.get(r.id)?.pegScore ?? null,
    liquidity: (r) => dexLiquidity?.[r.id]?.liquidityScore ?? null,
    grade: (r) => {
      const grade = reportCards?.[r.id]?.grade;
      return grade == null || grade === "NR" ? null : getReportCardGradeRank(grade);
    },
    blacklistable: (r) => {
      const status = getResolvedBlacklistStatus(r.id);
      if (status === null) return null;
      if (status === true) return 3;
      if (status === "possible" || status === "inherited") return 1;
      return 0;
    },
    mintAuthority: (r) => resolveMintAuthorityScoreDisplay(reportCards?.[r.id]?.mint).score,
    peg: (r) => {
      const meta = TRACKED_META_BY_ID.get(r.id);
      const bps = resolveCurrentDeviationBps(r, pegScores?.get(r.id), meta?.flags.navToken ? null : meta?.flags.pegCurrency);
      return bps == null ? null : Math.abs(bps);
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
      if (compared) return compared;
      if (effectiveSortKey === "grade") {
        // A held letter can sit beside a different raw score band; break the
        // tie inside one letter by the score, never to reorder the letters.
        const aScore = reportCards?.[a.row.id]?.score ?? Number.NEGATIVE_INFINITY;
        const bScore = reportCards?.[b.row.id]?.score ?? Number.NEGATIVE_INFINITY;
        const byScore = (sort.direction === "desc" ? -1 : 1) * (aScore - bScore);
        if (Number.isFinite(byScore) && byScore !== 0) return byScore;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export function exportStablecoinsCsv(
  sorted: StablecoinData[],
  sortedRankById: ReadonlyMap<string, number>,
  pegScores?: Map<string, PegSummaryCoin>,
  dexLiquidity?: DexLiquidityTableMap,
  reportCards?: Record<string, V9SafetyTableRow>,
  sourceGenerations?: StablecoinTableSourceGenerations,
  reportCardsMethodologyVersion?: string | null,
): void {
  const generationsBySource = {
    stablecoins: generationIso(sourceGenerations?.stablecoins),
    pegSummary: generationIso(sourceGenerations?.pegSummary),
    dexLiquidity: generationIso(sourceGenerations?.dexLiquidity),
    reportCards: generationIso(sourceGenerations?.reportCards),
  };
  const generationValues = Object.values(generationsBySource);
  // Mixed-source convention: the oldest known participating generation dates
  // the export; unread clocks stay null and never withhold those that were read.
  const knownGenerations = generationValues.filter((generation): generation is string => generation !== null);
  const asOfISO = knownGenerations.reduce<string | null>(
    (oldest, generation) => oldest === null || generation < oldest ? generation : oldest,
    null,
  ) ?? "unknown";
  // The Safety Score version belongs in the methodology label only when the
  // report-card response that supplied the grade/mint columns was loaded.
  const methodologyLabel = reportCards != null && reportCardsMethodologyVersion
    ? `published source values · safety-score ${toMethodologyVersionLabel(reportCardsMethodologyVersion)}`
    : "published source values";

  downloadCsvWithPreamble(
    sorted,
    [
      { header: "Rank", accessor: (row, i) => sortedRankById.get(row.id) ?? i + 1 },
      { header: "Name", accessor: (row) => row.name },
      { header: "Symbol", accessor: (row) => row.symbol },
      { header: "Price", accessor: (row) => isObservedPrice(row) ? row.price ?? null : null },
      { header: "Market Cap (USD)", accessor: (row) => getCirculatingRawOrNull(row) },
      {
        header: usesLegacyChangeWindow(sorted, "day") ? "24h Change (%)" : "24h Market Cap Change (%)",
        accessor: (row) => {
          const change = getSupplyChangePercent(row, "day");
          return change == null ? null : Number(change.toFixed(2));
        },
      },
      {
        header: usesLegacyChangeWindow(sorted, "week") ? "7d Change (%)" : "7d Market Cap Change (%)",
        accessor: (row) => {
          const change = getSupplyChangePercent(row, "week");
          return change == null ? null : Number(change.toFixed(2));
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
    {
      endpoint: "stablecoins",
      asOfISO,
      sourceUrl: typeof window === "undefined" ? "https://pharos.watch/" : window.location.href,
      methodologyLabel,
      sourceGenerations: generationsBySource,
    },
  );
}
