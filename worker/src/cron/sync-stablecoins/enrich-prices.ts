import { getCache } from "../../lib/db-cache";
import { throwIfAborted } from "../../lib/abort";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";
import { runEnrichmentPasses } from "./enrich-prices-fallback";

export { isReasonablePrice, PRICE_BOUNDS } from "../../lib/price-validation";
export {
  applyPoolChallenge,
  fetchPrimaryPrices,
  runGtProbePass,
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
): Promise<EnrichmentStats> {
  throwIfAborted(signal);
  const totalMissing = assets.filter(hasMissingPrice).length;
  if (totalMissing === 0) {
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

  let fxRates: Record<string, number> | undefined;
  if (db) {
    try {
      const fxCache = await getCache(db, "fx-rates");
      if (fxCache) fxRates = JSON.parse(fxCache.value);
    } catch (e) {
      console.warn("[enrich-prices] Failed to load FX rates for price bounds:", e);
    }
  }

  const { counts, failedPasses, providerDiagnostics } = await runEnrichmentPasses({
    assets,
    cmcApiKey,
    coingeckoApiKey,
    jupiterApiKey,
    db,
    fxRates,
    signal,
  });

  const finalMissing = assets.filter(hasMissingPrice).length;
  const totalEnriched = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(
    `[enrich] ${totalMissing} assets missing prices → ` +
    `Pass 1: +${counts.pass1}, Pass 1b (multi-chain): +${counts.pass1b}, ` +
    `Pass 2 (CMC): +${counts.passCmc}, ` +
    `Pass 3 (Jupiter): +${counts.passJupiter}, ` +
    `Pass 4 (DexScreener): +${counts.passDex}, ` +
    `Pass 5 (CG low-volume): +${counts.passCgLowVolume}, still missing: ${finalMissing}`
  );
  if (totalEnriched > 0) {
    console.log(`[sync-stablecoins] Enriched prices for ${totalEnriched} assets`);
  }
  return {
    totalMissing,
    ...counts,
    finalMissing,
    failedPasses, providerDiagnostics,
  };
}
