import { derivePegRates, type PegRateSource } from "@shared/lib/peg-rates";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { buildPegSummaryCoinMap } from "@/lib/stablecoin-lookups";
import { buildV9SafetyTableMap, type V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";

interface StablecoinTableInputsArgs {
  stablecoins?: StablecoinData[] | null;
  fxFallbackRates?: Record<string, number>;
  pegSummaryCoins?: readonly PegSummaryCoin[] | null;
  reportCardsV9?: ReportCardsV9CurrentResponse | null;
}

interface StablecoinTableInputs {
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegScores: Map<string, PegSummaryCoin>;
  reportCards: Record<string, V9SafetyTableRow> | undefined;
}

export function buildStablecoinTableInputs({
  stablecoins,
  fxFallbackRates,
  pegSummaryCoins,
  reportCardsV9,
}: StablecoinTableInputsArgs): StablecoinTableInputs {
  const { rates: pegRates, sources: pegRateSources } = derivePegRates(
    stablecoins ?? [],
    TRACKED_META_BY_ID,
    fxFallbackRates,
  );

  const projectedRatings = reportCardsV9
    ? buildV9SafetyTableMap(reportCardsV9, reportCardsV9.safetyScoreIdentity)
    : null;

  return {
    pegRates,
    pegRateSources,
    pegScores: buildPegSummaryCoinMap(pegSummaryCoins),
    reportCards: projectedRatings?.status === "available" ? projectedRatings.value : undefined,
  };
}
