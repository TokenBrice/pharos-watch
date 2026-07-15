import type {
  FilterTag,
  PegSummaryResponse,
  ReportCardsResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "@shared/types";
import { getDewsRiskLevel, isThreatBand } from "@shared/lib/classification";
import { buildTrackedIdSet, filterStablecoins } from "@/components/stablecoin-table-logic";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import { buildReportCardMap } from "@/lib/stablecoin-lookups";

interface HomepageFiltersState {
  activeFilters: readonly FilterTag[];
  searchQuery: string;
}

export function buildHomepageCriticalViewModel(args: {
  stablecoinsData?: StablecoinListResponse;
  pegSummaryData?: PegSummaryResponse;
  filters: HomepageFiltersState;
  reportCardMap?: ReturnType<typeof buildReportCardMap>;
  eligibleIds?: ReadonlySet<string>;
}) {
  const tableInputs = buildStablecoinTableInputs({
    stablecoins: args.stablecoinsData?.peggedAssets,
    fxFallbackRates: args.stablecoinsData?.fxFallbackRates,
    pegSummaryCoins: args.pegSummaryData?.coins,
  });
  const trackedIds = buildTrackedIdSet(args.filters.activeFilters, args.reportCardMap, args.eligibleIds);
  const filteredRowCount = filterStablecoins(
    args.stablecoinsData?.peggedAssets,
    trackedIds,
    args.filters.searchQuery,
  ).length;

  return {
    pegScores: tableInputs.pegScores,
    pegRates: tableInputs.pegRates,
    filteredRowCount,
  };
}

export function buildHomepageOptionalViewModel(args: {
  reportCardsData?: ReportCardsResponse;
  stressData?: StressSignalsAllResponse;
}) {
  const reportCardMap = buildReportCardMap(args.reportCardsData?.cards);

  return {
    reportCardMap,
    dewsRiskLevel: getDewsRiskLevel(
      args.stressData?.signals
        ? Object.values(args.stressData.signals)
            .map((signal) => signal.band)
            .filter(isThreatBand)
        : [],
    ),
  };
}
