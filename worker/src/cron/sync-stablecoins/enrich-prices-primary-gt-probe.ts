import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { sumPegBuckets } from "@shared/lib/supply";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { getReferencePriceForContext } from "../../lib/price-validation";
import { computePriceConsensus, type SourcePrice } from "../../lib/price-consensus";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { isGtProbeEligibleSingleSource } from "../../lib/pricing-source-policy";
import { createValidationContextResolver, type ValidationContextResolver } from "./pricing";
import type { PeggedAsset, PrimaryPriceResult } from "./enrich-prices-shared";
import { getSourceDefaultWeight } from "./enrich-prices-primary-shared";

export interface GtProbeTarget {
  id: string;
  price: number;
  priorityUsd: number;
}

export function buildGtProbeTargets(
  assets: PeggedAsset[],
  primaryResults: Map<string, PrimaryPriceResult>,
): GtProbeTarget[] {
  const targets: GtProbeTarget[] = [];

  for (const asset of assets) {
    const primary = primaryResults.get(asset.id);
    if (!primary) continue;

    const hasHardAuthoritativeSource = primary.candidateSources.some((source) => (
      getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false
    ));
    if (
      !hasHardAuthoritativeSource &&
      (primary.confidence === "single-source" || primary.confidence === "low") &&
      primary.candidateSources.some((source) => isGtProbeEligibleSingleSource(source))
    ) {
      targets.push({
        id: asset.id,
        price: primary.price,
        priorityUsd: sumPegBuckets(asset.circulating),
      });
    }
  }

  return targets;
}

export function applyGtProbeMutation(params: {
  asset: PeggedAsset;
  primary: PrimaryPriceResult;
  gtSource: SourcePrice;
  validationContexts: ValidationContextResolver;
  references?: PriceValidationReferences;
}): boolean {
  const { asset, primary, gtSource, validationContexts, references } = params;
  const sources: SourcePrice[] = [];
  for (const source of primary.candidateSources) {
    const price = primary.allPrices?.[source];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    sources.push({
      source,
      price,
      weight: getSourceDefaultWeight(source),
      observedAt: primary.observedAtBySource?.[source] ?? null,
      observedAtMode: primary.observedAtModeBySource?.[source] ?? null,
    });
  }
  sources.push(gtSource);

  const context = validationContexts.get(asset);
  const pegRef = context.navToken ? null : getReferencePriceForContext(context, references);
  const consensus = computePriceConsensus(sources, pegRef, DIVERGENCE_THRESHOLD_BPS, {
    mode: context.navToken ? "nav" : "fixed",
  });

  if (!consensus) return false;

  primary.price = consensus.price;
  primary.source = consensus.source;
  primary.selectedSource = consensus.selectedSource;
  primary.priceEstimator = consensus.priceEstimator;
  primary.confidence = consensus.confidence;
  primary.candidateSources = sources.map((source) => source.source);
  primary.agreeSources = consensus.agreeSources;
  primary.disagreeSources = consensus.disagreeSources;
  primary.allPrices = consensus.allPrices;
  primary.observedAt = consensus.observedAt;
  primary.observedAtMode = consensus.observedAtMode;
  primary.observedAtBySource = consensus.observedAtBySource;
  primary.observedAtModeBySource = consensus.observedAtModeBySource;
  return true;
}

/**
 * For assets that are single-source eligible soft-source results after primary consensus,
 * probe GeckoTerminal for an independent pool-level price and re-run
 * consensus with the additional source.
 */
export async function runGtProbePass(
  assets: PeggedAsset[],
  primaryResults: Map<string, PrimaryPriceResult>,
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
  validationContexts?: ValidationContextResolver,
): Promise<{ updatedCount: number; stats: import("../../lib/geckoterminal-price-probe").GtProbeStats }> {
  const { createEmptyGtProbeStats, probeGeckoTerminalPrices } = await import("../../lib/geckoterminal-price-probe");
  const contexts = validationContexts ?? createValidationContextResolver();
  const gtProbeTargets = buildGtProbeTargets(assets, primaryResults);

  if (gtProbeTargets.length === 0) {
    return {
      updatedCount: 0,
      stats: createEmptyGtProbeStats(),
    };
  }

  const { prices: gtPrices, stats } = await probeGeckoTerminalPrices(gtProbeTargets, db, signal, coingeckoApiKey);

  let updatedCount = 0;
  for (const asset of assets) {
    const gtSource = gtPrices.get(asset.id);
    if (!gtSource) continue;

    const primary = primaryResults.get(asset.id);
    if (!primary) continue;

    if (applyGtProbeMutation({
      asset,
      primary,
      gtSource,
      validationContexts: contexts,
      references,
    })) {
      updatedCount++;
    }
  }

  return { updatedCount, stats };
}
