import type {
  DexLiquidityMap,
  FilterTag,
  PegSummaryResponse,
  ReportCardsResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "@shared/types";
import { derivePegRates } from "@shared/lib/peg-rates";
import { getDewsRiskLevel, isThreatBand } from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { buildTrackedIdSet, filterStablecoins } from "@/components/stablecoin-table-logic";
import { buildPegSummaryCoinMap, buildReportCardMap } from "@/lib/stablecoin-lookups";

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
  const reportCardMap = buildReportCardMap(args.reportCardsData?.cards);
  const pegScores = buildPegSummaryCoinMap(args.pegSummaryData?.coins);
  const { rates: pegRates } = derivePegRates(
    args.stablecoinsData?.peggedAssets ?? [],
    TRACKED_META_BY_ID,
    args.stablecoinsData?.fxFallbackRates,
  );
  const trackedIds = buildTrackedIdSet([...args.filters.activeFilters], reportCardMap);
  const filteredRowCount = filterStablecoins(
    args.stablecoinsData?.peggedAssets,
    trackedIds,
    args.filters.searchQuery,
  ).length;

  return {
    reportCardMap,
    pegScores,
    pegRates,
    filteredRowCount,
    dewsRiskLevel: getDewsRiskLevel(
      args.stressData?.signals
        ? Object.values(args.stressData.signals).map((signal) => signal.band).filter(isThreatBand)
        : [],
    ),
    hasDexLiquidity: !!args.dexLiquidity,
  };
}
