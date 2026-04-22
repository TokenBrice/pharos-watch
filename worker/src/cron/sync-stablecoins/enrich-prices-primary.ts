import type { PriceValidationReferences } from "../../lib/price-validation";
import { throwIfAborted } from "../../lib/abort";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { DlListQuote } from "../../lib/primary-price-collector";
import { createValidationContextResolver, type ValidationContextResolver } from "./pricing";
import type { PeggedAsset, PrimaryPriceResult } from "./enrich-prices-shared";
import type { PriceValidationStats } from "./enrich-prices-primary-shared";
import {
  buildPrimaryPricePlan,
  collectPrimaryProviderQuotes,
} from "./enrich-prices-primary-provider-collection";
import { buildPrimaryConsensusResults } from "./enrich-prices-primary-consensus";
import {
  applyListAggregatorDowngrade,
  applyPoolChallenge,
  applyPrimaryPostConsensusHardening,
} from "./enrich-prices-primary-hardening";
import { runGtProbePass } from "./enrich-prices-primary-gt-probe";

export type { PrimaryPriceResult, PriceValidationStats };
export { applyListAggregatorDowngrade, applyPoolChallenge, runGtProbePass };

/**
 * Fetch prices from CG, Pyth, CEX tickers, Curve on-chain, and DEX sources in parallel,
 * cross-validate within 50bps, and return a confidence-tagged result per asset.
 * Optionally accepts DL stablecoins list prices as an independent voice.
 */
export async function fetchPrimaryPrices(
  assets: PeggedAsset[],
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  dlListPrices?: Map<string, number | DlListQuote>,
  validationContexts?: ValidationContextResolver,
): Promise<{
  results: Map<string, PrimaryPriceResult>;
  stats: PriceValidationStats;
  cgPrices: Map<string, number>;
  providerDiagnostics?: PricingProviderAttemptDiagnostic[];
}> {
  throwIfAborted(signal);

  const resolveDlListQuote = (assetId: string): DlListQuote | undefined => {
    const entry = dlListPrices?.get(assetId);
    if (entry == null) return undefined;
    if (typeof entry === "number") {
      return {
        price: entry,
        observedAt: null,
        observedAtMode: "unknown",
      };
    }
    return entry;
  };

  const contexts = validationContexts ?? createValidationContextResolver();
  const results = new Map<string, PrimaryPriceResult>();
  const stats: PriceValidationStats = { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 };
  const plan = await buildPrimaryPricePlan(assets, db, dlListPrices);

  if (plan.candidates.length === 0) {
    return { results, stats, cgPrices: new Map() };
  }

  const { quoteMaps, providerDiagnostics } = await collectPrimaryProviderQuotes({
    plan,
    db,
    signal,
    coingeckoApiKey,
    chainRpcs,
  });

  buildPrimaryConsensusResults({
    candidates: plan.candidates,
    references,
    quoteMaps,
    dexRows: plan.dexRows,
    dexPriceSources: plan.dexPriceSources,
    nowSec: plan.nowSec,
    resolveDlListQuote,
    results,
    stats,
    validationContexts: contexts,
  });

  await applyPrimaryPostConsensusHardening({
    db,
    candidates: plan.candidates,
    results,
    stats,
    nowSec: plan.nowSec,
    references,
    validationContexts: contexts,
  });

  if (dlListPrices) {
    const withDl = plan.candidates.filter((asset) => dlListPrices.has(asset.id)).length;
    const withoutDl = plan.candidates.length - withDl;
    if (withoutDl > 0) {
      console.log(`[primary-prices] DL list coverage: ${withDl}/${plan.candidates.length} (${withoutDl} missing)`);
    }
  }

  console.log(
    `[primary-prices] ${stats.attempted} assets: ${stats.high} high, ${stats.singleSource} single-source, ${stats.low} low confidence`,
  );

  return {
    results,
    stats,
    cgPrices: quoteMaps.cgPrices,
    providerDiagnostics,
  };
}
