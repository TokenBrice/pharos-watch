import type {
  DexLiquidityMap,
  FilterTag,
  PegSummaryResponse,
  ReportCardsResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "@shared/types";
import { getDewsRiskLevel, isThreatBand } from "@shared/lib/classification";
import { buildTrackedIdSet, filterStablecoins } from "@/components/stablecoin-table-logic";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";

interface HomepageFiltersState {
  activeFilters: readonly FilterTag[];
  searchQuery: string;
}

export function buildHomepageViewModel(args: {
  stablecoinsData?: StablecoinListResponse;
  pegSummaryData?: PegSummaryResponse;
  reportCardsData?: ReportCardsResponse;
  stressData?: StressSignalsAllResponse;
  dexLiquidity?: DexLiquidityMap;
  filters: HomepageFiltersState;
}) {
  const tableInputs = buildStablecoinTableInputs({
    stablecoins: args.stablecoinsData?.peggedAssets,
    fxFallbackRates: args.stablecoinsData?.fxFallbackRates,
    pegSummaryCoins: args.pegSummaryData?.coins,
    reportCards: args.reportCardsData?.cards,
  });
  const reportCardMap = tableInputs.reportCards;
  const trackedIds = buildTrackedIdSet(args.filters.activeFilters, reportCardMap);
  const filteredRowCount = filterStablecoins(
    args.stablecoinsData?.peggedAssets,
    trackedIds,
    args.filters.searchQuery,
  ).length;

  return {
    reportCardMap,
    pegScores: tableInputs.pegScores,
    pegRates: tableInputs.pegRates,
    filteredRowCount,
    dewsRiskLevel: getDewsRiskLevel(
      args.stressData?.signals
        ? Object.values(args.stressData.signals).map((signal) => signal.band).filter(isThreatBand)
        : [],
    ),
    hasDexLiquidity: !!args.dexLiquidity,
  };
}
