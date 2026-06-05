import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import type { PriceValidationContext, PriceValidationReferences } from "../../lib/price-validation";
import {
  buildPriceValidationContext,
  isSevereFixedPegDownside,
} from "../../lib/price-validation";
import {
  DEX_FRESHNESS_SEC,
  POOL_CHALLENGE_HIGH_TVL_USD,
  POOL_CHALLENGE_MIN_TVL,
  getDepegThresholdBps,
} from "../../lib/constants";
import { loadDexPoolChallengers } from "../../lib/depeg-helpers";
import { aggregateProtocolPrices, computeWeightedMedianPrice } from "../../lib/dex-price-estimators";
import { isPoolChallengeEligibleConsensus } from "../../lib/pricing-source-policy";
import type { ValidationContextResolver } from "./pricing";
import type { PeggedAsset, PrimaryPriceResult } from "./enrich-prices-shared";
import type { PriceValidationStats } from "./enrich-prices-primary-shared";

/**
 * Downgrades 2-source clusters whose members are all list-style aggregators
 * (registry flag `isListAggregator`) from "high" to "single-source". Rationale:
 * list aggregators tend to re-export the same upstream list data, so two voices
 * from this family are not independent corroboration. Exported for unit testing.
 */
export function applyListAggregatorDowngrade(
  results: Map<string, PrimaryPriceResult>,
  stats: PriceValidationStats,
): void {
  for (const result of results.values()) {
    if (result.confidence !== "high") continue;
    const agreeSources = normalizePricingSourceKeys(result.agreeSources);
    if (agreeSources.length !== 2) continue;
    const allListAggregator = agreeSources.every(
      (source) => getPricingSourceRegistryEntry(source)?.isListAggregator === true,
    );
    if (!allListAggregator) continue;
    result.confidence = "single-source";
    stats.high--;
    stats.singleSource++;
  }
}

export async function applyPrimaryPostConsensusHardening(params: {
  db: D1Database;
  candidates: PeggedAsset[];
  results: Map<string, PrimaryPriceResult>;
  stats: PriceValidationStats;
  nowSec: number;
  references?: PriceValidationReferences;
  validationContexts?: ValidationContextResolver;
}): Promise<void> {
  applyListAggregatorDowngrade(params.results, params.stats);

  const poolChallengers = await loadDexPoolChallengers(
    params.db,
    POOL_CHALLENGE_MIN_TVL,
    DEX_FRESHNESS_SEC,
    params.nowSec,
  );
  const assetPegTypes = new Map(params.candidates.map((asset) => [asset.id, asset.pegType]));
  const navTokenAssetIds = new Set(
    params.candidates.filter((asset) => asset.navToken).map((asset) => asset.id),
  );
  const challengeValidationContexts = params.validationContexts
    ? new Map(
        params.candidates.map((asset) => [asset.id, params.validationContexts!.get(asset)]),
      )
    : undefined;
  const poolChallengeDowngrades = applyPoolChallenge(
    params.results,
    poolChallengers,
    assetPegTypes,
    params.stats,
    params.references,
    navTokenAssetIds,
    challengeValidationContexts,
  );
  if (poolChallengeDowngrades > 0) {
    console.log(`[primary-prices] Pool challenge hardened ${poolChallengeDowngrades} soft-only result(s)`);
  }
}

/**
 * Post-consensus pool challenge: downgrade soft-only results when
 * large DEX pools diverge from the consensus price.
 */
export function applyPoolChallenge(
  results: Map<string, PrimaryPriceResult>,
  poolChallengers: Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string; observedAt?: number }>>,
  assetPegTypes: Map<string, string | undefined>,
  stats: PriceValidationStats,
  references?: PriceValidationReferences,
  navTokenAssetIds?: Set<string>,
  validationContexts?: Map<string, PriceValidationContext>,
): number {
  let downgrades = 0;
  for (const [assetId, result] of results) {
    if (result.confidence !== "high" && result.confidence !== "single-source" && result.confidence !== "low") continue;
    if (navTokenAssetIds?.has(assetId)) continue;
    const challengeSources = result.confidence === "low" ? result.candidateSources : result.agreeSources;
    if (!isPoolChallengeEligibleConsensus(challengeSources)) continue;

    const pools = poolChallengers.get(assetId);
    if (!pools?.length) continue;
    const protocolGroups = aggregateProtocolPrices(
      pools.map((pool) => ({
        protocol: pool.protocol,
        price: pool.price,
        tvl: pool.tvlUsd,
        chain: pool.chain,
        observedAt: pool.observedAt,
      })),
    );
    if (protocolGroups.length === 0) continue;

    const pegType = assetPegTypes.get(assetId);
    const poolChallengeBps = pegType === "peggedUSD"
      ? 500
      : Math.min(getDepegThresholdBps(pegType) * 2, 500);
    const validationContext = validationContexts?.get(assetId);
    const preserveCorroboratedSevereDownside = hasCorroboratedSevereDownsideCandidate(
      assetId,
      result,
      pegType,
      references,
      validationContext,
    );

    // Evaluate divergence from one protocol-level price, not from any single pool.
    // A rogue pool inside an otherwise agreeing protocol should not count as
    // independent corroboration for replacing the published price.
    const divergingProtocolGroups = protocolGroups.filter((group) => {
      return pricePairDivergenceBps(result.price, group.price) >= poolChallengeBps;
    });
    const replacementProtocolGroups = selectReplacementProtocolGroups({
      result,
      protocolGroups,
      divergingProtocolGroups,
      pegType,
      references,
      validationContext,
    });

    if (divergingProtocolGroups.length > 0 || replacementProtocolGroups.length > 0) {
      if (result.confidence === "high") {
        result.confidence = "low";
        stats.high--;
        stats.low++;
      } else if (result.confidence === "single-source") {
        result.confidence = "low";
        stats.singleSource--;
        stats.low++;
      }
      downgrades++;

      if (replacementProtocolGroups.length > 0 && !preserveCorroboratedSevereDownside) {
        const replacementPrice = computeWeightedMedianPrice(
          replacementProtocolGroups.map((group) => ({
            price: group.price,
            weight: group.tvl,
          })),
        );
        if (replacementPrice != null) {
          result.price = replacementPrice;
          result.source = "pool-tvl-weighted";
          result.selectedSource = "pool-tvl-weighted";
          result.priceEstimator = "selected_source";
          const poolObservedAts = replacementProtocolGroups
            .map((group) => group.observedAt)
            .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          result.observedAt = poolObservedAts.length > 0
            ? Math.min(...poolObservedAts)
            : result.observedAt;
          result.observedAtMode = "local_fetch";
          result.candidateSources = [...new Set([...result.candidateSources, "pool-tvl-weighted"])];
          result.agreeSources = ["pool-tvl-weighted"];
          result.disagreeSources = result.candidateSources.filter((source) => source !== "pool-tvl-weighted");
          result.allPrices = { "pool-tvl-weighted": replacementPrice };
          result.observedAtBySource = {
            "pool-tvl-weighted": poolObservedAts.length > 0 ? Math.min(...poolObservedAts) : result.observedAt ?? null,
          };
          result.observedAtModeBySource = { "pool-tvl-weighted": "local_fetch" };
        }
      }
    }
  }
  return downgrades;
}

function selectReplacementProtocolGroups(params: {
  result: PrimaryPriceResult;
  protocolGroups: Array<{ price: number; tvl: number; observedAt?: number | null }>;
  divergingProtocolGroups: Array<{ price: number; tvl: number; observedAt?: number | null }>;
  pegType: string | undefined;
  references?: PriceValidationReferences;
  validationContext?: PriceValidationContext;
}): Array<{ price: number; tvl: number; observedAt?: number | null }> {
  if (params.divergingProtocolGroups.length >= 2) {
    return params.divergingProtocolGroups;
  }

  const context =
    params.validationContext ??
    buildPriceValidationContext({ pegType: params.pegType });
  const pegRef = getCurrentPegReference(context, params.references);
  if (pegRef == null) return [];

  const depegThresholdBps = getDepegThresholdBps(params.pegType);
  const resultAbsBps = Math.abs(priceDeviationBps(params.result.price, pegRef));
  if (resultAbsBps >= depegThresholdBps) {
    return [];
  }

  return params.protocolGroups.filter((group) => (
    group.tvl >= POOL_CHALLENGE_HIGH_TVL_USD &&
    Math.abs(priceDeviationBps(group.price, pegRef)) >= depegThresholdBps &&
    pricePairDivergenceBps(params.result.price, group.price) >= depegThresholdBps &&
    hasHardCandidateAgreement(params.result, group.price)
  ));
}

function hasHardCandidateAgreement(result: PrimaryPriceResult, price: number): boolean {
  const candidatePrices = result.allPrices ?? {};
  return Object.entries(candidatePrices).some(([source, candidatePrice]) => {
    const trustTier = getPricingSourceRegistryEntry(source)?.trustTier;
    const isHard =
      trustTier === "hard_market" ||
      trustTier === "hard_oracle" ||
      trustTier === "hard_protocol";
    return isHard && pricePairDivergenceBps(price, candidatePrice) <= DIVERGENCE_THRESHOLD_BPS;
  });
}

function getCurrentPegReference(
  context: PriceValidationContext,
  references?: PriceValidationReferences,
): number | null {
  if (context.pegClass === "usd") return 1;
  const pegType = context.pegType;
  if (!pegType) return null;
  const reference = references?.rates[pegType];
  if (typeof reference !== "number" || !Number.isFinite(reference) || reference <= 0) {
    return null;
  }
  const scale =
    typeof context.commodityOunces === "number" &&
    Number.isFinite(context.commodityOunces) &&
    context.commodityOunces > 0
      ? context.commodityOunces
      : 1;
  return reference * scale;
}

function priceDeviationBps(price: number, pegRef: number): number {
  return ((price / pegRef) - 1) * 10_000;
}

function pricePairDivergenceBps(left: number, right: number): number {
  const mid = (left + right) / 2;
  if (mid <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(left - right) / mid) * 10_000;
}

function hasCorroboratedSevereDownsideCandidate(
  assetId: string,
  result: PrimaryPriceResult,
  pegType: string | undefined,
  references?: PriceValidationReferences,
  cachedContext?: PriceValidationContext,
): boolean {
  const context = cachedContext ?? buildPriceValidationContext({ stablecoinId: assetId, pegType });
  if (!isSevereFixedPegDownside(result.price, context, references)) {
    return false;
  }

  const candidatePrices = result.allPrices ?? {};
  const severeSources = Object.entries(candidatePrices)
    .filter(([, price]) => isSevereFixedPegDownside(price, context, references))
    .map(([source]) => source);
  if (severeSources.length < 2) {
    return false;
  }

  return severeSources.some((source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false);
}
