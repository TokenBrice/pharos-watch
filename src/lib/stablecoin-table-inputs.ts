import { derivePegRates, type PegRateSource } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { PegSummaryCoin, ReportCard, StablecoinData } from "@shared/types";
import { buildPegSummaryCoinMap, buildReportCardMap } from "@/lib/stablecoin-lookups";

interface StablecoinTableInputsArgs {
  stablecoins?: StablecoinData[] | null;
  fxFallbackRates?: Record<string, number>;
  pegSummaryCoins?: readonly PegSummaryCoin[] | null;
  reportCards?: readonly ReportCard[] | null;
}

interface StablecoinTableInputs {
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegScores: Map<string, PegSummaryCoin>;
  reportCards: Record<string, ReportCard> | undefined;
}

export function buildStablecoinTableInputs({
  stablecoins,
  fxFallbackRates,
  pegSummaryCoins,
  reportCards,
}: StablecoinTableInputsArgs): StablecoinTableInputs {
  const { rates: pegRates, sources: pegRateSources } = derivePegRates(
    stablecoins ?? [],
    TRACKED_META_BY_ID,
    fxFallbackRates,
  );

  return {
    pegRates,
    pegRateSources,
    pegScores: buildPegSummaryCoinMap(pegSummaryCoins),
    reportCards: buildReportCardMap(reportCards),
  };
}
