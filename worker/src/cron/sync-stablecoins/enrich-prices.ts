import { throwIfAborted } from "../../lib/abort";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";
import { runEnrichmentPasses } from "./enrich-prices-fallback";
import {
  loadFxRatesForPriceBounds,
  logEnrichmentSummary,
  type EnrichmentProgressReporter,
} from "./enrich-prices-progress";

export { isReasonablePrice } from "../../lib/price-validation";
export {
  applyPoolChallenge,
  fetchPrimaryPrices,
  type PriceValidationStats,
  type PrimaryPriceResult,
} from "./enrich-prices-primary";

export interface DefiLlamaCoinPrice {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
}
export type { PeggedAsset } from "./enrich-prices-shared";
export { applyResolvedPrice, hasMissingPrice } from "./enrich-prices-shared";

export interface EnrichmentStats {
  totalMissing: number;
  pass1: number;
  pass1b: number;
  passCmc: number;
  passJupiter: number;
  passDex: number;
  passCgLowVolume: number;
  finalMissing: number;
  failedPasses: string[];
  providerDiagnostics?: PricingProviderAttemptDiagnostic[];
}

export async function enrichMissingPrices(
  assets: PeggedAsset[],
  cmcApiKey?: string,
  db?: D1Database,
  signal?: AbortSignal,
  jupiterApiKey?: string | null,
  coingeckoApiKey?: string | null,
  onProgress?: EnrichmentProgressReporter,
  previousMissingGenerationsById?: ReadonlyMap<string, number>,
): Promise<EnrichmentStats> {
  throwIfAborted(signal);
  const totalMissing = assets.filter(hasMissingPrice).length;
  await onProgress?.({ phase: "start", totalMissing });
  if (totalMissing === 0) {
    await onProgress?.({ phase: "complete", totalMissing, finalMissing: 0, failedPasses: [] });
    return {
      totalMissing: 0,
      pass1: 0,
      pass1b: 0,
      passCmc: 0,
      passJupiter: 0,
      passDex: 0,
      passCgLowVolume: 0,
      finalMissing: 0,
      failedPasses: [],
    };
  }

  const fxRates = await loadFxRatesForPriceBounds(db);
  await onProgress?.({ phase: "fx-rates-loaded", totalMissing });

  const { counts, failedPasses, providerDiagnostics } = await runEnrichmentPasses({
    assets,
    cmcApiKey,
    coingeckoApiKey,
    jupiterApiKey,
    db,
    fxRates,
    signal,
    previousMissingGenerationsById,
    onProgress: async (progress) => {
      await onProgress?.({
        phase: progress.phase,
        totalMissing,
        finalMissing: progress.missingAfterPass,
        pass: progress,
        failedPasses: progress.failedPasses,
      });
    },
  });

  const finalMissing = assets.filter(hasMissingPrice).length;
  await onProgress?.({ phase: "complete", totalMissing, finalMissing, failedPasses });
  logEnrichmentSummary(totalMissing, counts, finalMissing);
  return {
    totalMissing,
    ...counts,
    finalMissing,
    failedPasses, providerDiagnostics,
  };
}
