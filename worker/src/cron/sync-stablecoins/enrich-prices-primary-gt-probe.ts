import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { isGtProbeEligibleSingleSource } from "@shared/lib/pricing-source-policy";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { getReferencePriceForContext } from "../../lib/price-validation";
import { computePriceConsensus, type SourcePrice } from "../../lib/price-consensus";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import type { ValidationContextResolver } from "./pricing";
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
        priorityUsd: getCirculatingRaw(asset),
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
