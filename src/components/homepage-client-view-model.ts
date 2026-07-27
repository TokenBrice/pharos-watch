import type {
  FilterTag,
  PegSummaryResponse,
  ReportCardsV9Response,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "@shared/types";
import { getDewsRiskLevel, isThreatBand } from "@shared/lib/classification";
import { buildTrackedIdSet, filterStablecoins } from "@/components/stablecoin-table-logic";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import { buildV9SafetyTableMap } from "@/lib/safety-score-v9-consumers";

interface HomepageFiltersState {
  activeFilters: readonly FilterTag[];
  searchQuery: string;
}

export function buildHomepageCriticalViewModel(args: {
  stablecoinsData?: StablecoinListResponse;
  pegSummaryData?: PegSummaryResponse;
  filters: HomepageFiltersState;
  reportCardMap?: Record<string, import("@/lib/safety-score-v9-consumers").V9SafetyTableRow>;
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
  reportCardsData?: ReportCardsV9Response;
  stressData?: StressSignalsAllResponse;
}) {
  const projected = args.reportCardsData
    ? buildV9SafetyTableMap(args.reportCardsData, args.reportCardsData.safetyScoreIdentity)
    : null;
  const reportCardMap = projected?.status === "available" ? projected.value : undefined;

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
