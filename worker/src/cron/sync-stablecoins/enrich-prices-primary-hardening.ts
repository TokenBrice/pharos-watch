import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { isPoolChallengeEligibleConsensus } from "@shared/lib/pricing-source-policy";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import type { PriceValidationContext, PriceValidationReferences } from "../../lib/price-validation";
import {
  buildPriceValidationContext,
  isSevereFixedPegDownside,
  validatePriceCandidate,
} from "../../lib/price-validation";
import { POOL_CHALLENGE_HIGH_TVL_USD, getDepegThresholdBps } from "../../lib/constants";
import { aggregateProtocolPrices, computeWeightedMedianPrice } from "../../lib/dex-price-estimators";
import type { PrimaryPriceResult } from "./enrich-prices-shared";
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
    const challengeSources = result.agreeSources.length > 0 ? result.agreeSources : [result.source];
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

    const validationContext = validationContexts?.get(assetId);
    const pegType = assetPegTypes.get(assetId);
    const challengeContext =
      validationContext ??
      buildPriceValidationContext({ stablecoinId: assetId, pegType });
    const challengeableProtocolGroups = filterChallengeableProtocolGroups(
      protocolGroups,
      challengeContext,
      references,
    );
    if (challengeableProtocolGroups.length === 0) continue;

    const poolChallengeBps = pegType === "peggedUSD"
      ? 500
      : Math.min(getDepegThresholdBps(pegType) * 2, 500);
    const preserveCorroboratedSevereDownside = hasCorroboratedSevereDownsideCandidate(
      assetId,
      result,
      pegType,
      references,
      challengeContext,
    );

    // Evaluate divergence from one protocol-level price, not from any single pool.
    // A rogue pool inside an otherwise agreeing protocol should not count as
    // independent corroboration for replacing the published price.
    const divergingProtocolGroups = challengeableProtocolGroups.filter((group) => {
      return pricePairDivergenceBps(result.price, group.price) >= poolChallengeBps;
    });
    const replacementProtocolGroups = selectReplacementProtocolGroups({
      result,
      protocolGroups: challengeableProtocolGroups,
      divergingProtocolGroups,
      pegType,
      poolChallengeBps,
      references,
      validationContext: challengeContext,
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

function filterChallengeableProtocolGroups(
  protocolGroups: Array<{ price: number; tvl: number; observedAt?: number | null }>,
  validationContext: PriceValidationContext,
  references?: PriceValidationReferences,
): Array<{ price: number; tvl: number; observedAt?: number | null }> {
  return protocolGroups.filter((group) => (
    validatePriceCandidate(group.price, validationContext, "dex_observation", references).accepted
  ));
}

function selectReplacementProtocolGroups(params: {
  result: PrimaryPriceResult;
  protocolGroups: Array<{ price: number; tvl: number; observedAt?: number | null }>;
  divergingProtocolGroups: Array<{ price: number; tvl: number; observedAt?: number | null }>;
  pegType: string | undefined;
  poolChallengeBps: number;
  references?: PriceValidationReferences;
  validationContext: PriceValidationContext;
}): Array<{ price: number; tvl: number; observedAt?: number | null }> {
  if (params.divergingProtocolGroups.length >= 2) {
    return params.divergingProtocolGroups;
  }

  const pegRef = getCurrentPegReference(params.validationContext, params.references);
  if (pegRef == null) return [];

  const depegThresholdBps = getDepegThresholdBps(params.pegType);
  const resultAbsBps = Math.abs(priceDeviationBps(params.result.price, pegRef));
  if (resultAbsBps < depegThresholdBps) {
    const directionalHighTvlGroups = selectHighTvlDirectionalReplacementGroups({
      protocolGroups: params.protocolGroups,
      pegRef,
      depegThresholdBps,
      poolChallengeBps: params.poolChallengeBps,
      resultPrice: params.result.price,
    });
    if (directionalHighTvlGroups.length >= 2) {
      return directionalHighTvlGroups;
    }
  }

  return params.protocolGroups.filter((group) => (
    group.tvl >= POOL_CHALLENGE_HIGH_TVL_USD &&
    Math.abs(priceDeviationBps(group.price, pegRef)) >= depegThresholdBps &&
    pricePairDivergenceBps(params.result.price, group.price) >= depegThresholdBps &&
    hasHardCandidateAgreement(params.result, group.price)
  ));
}

function selectHighTvlDirectionalReplacementGroups(params: {
  protocolGroups: Array<{ price: number; tvl: number; observedAt?: number | null }>;
  pegRef: number;
  depegThresholdBps: number;
  poolChallengeBps: number;
  resultPrice: number;
}): Array<{ price: number; tvl: number; observedAt?: number | null }> {
  const eligibleGroups = params.protocolGroups.filter((group) => (
    group.tvl >= POOL_CHALLENGE_HIGH_TVL_USD &&
    Math.abs(priceDeviationBps(group.price, params.pegRef)) >= params.depegThresholdBps &&
    pricePairDivergenceBps(params.resultPrice, group.price) >= params.depegThresholdBps
  ));
  if (eligibleGroups.length < 2) return [];

  const byDirection = new Map<-1 | 1, Array<{ price: number; tvl: number; observedAt?: number | null }>>();
  for (const group of eligibleGroups) {
    const direction = priceDeviationBps(group.price, params.pegRef) < 0 ? -1 : 1;
    const groups = byDirection.get(direction) ?? [];
    groups.push(group);
    byDirection.set(direction, groups);
  }

  let selected: Array<{ price: number; tvl: number; observedAt?: number | null }> = [];
  for (const groups of byDirection.values()) {
    if (groups.length < 2) continue;
    const coherentGroups = selectLargestCoherentProtocolGroup(groups, params.poolChallengeBps);
    const selectedTvl = selected.reduce((sum, group) => sum + group.tvl, 0);
    const candidateTvl = coherentGroups.reduce((sum, group) => sum + group.tvl, 0);
    if (
      coherentGroups.length > selected.length ||
      (coherentGroups.length === selected.length && candidateTvl > selectedTvl)
    ) {
      selected = coherentGroups;
    }
  }

  return selected;
}

function selectLargestCoherentProtocolGroup<T extends { price: number; tvl: number }>(
  groups: T[],
  thresholdBps: number,
): T[] {
  let selected: T[] = [];

  function visit(index: number, candidate: T[]): void {
    if (candidate.length + groups.length - index < Math.max(2, selected.length)) return;
    if (index >= groups.length) {
      const selectedTvl = selected.reduce((sum, group) => sum + group.tvl, 0);
      const candidateTvl = candidate.reduce((sum, group) => sum + group.tvl, 0);
      if (
        candidate.length >= 2 &&
        (candidate.length > selected.length ||
          (candidate.length === selected.length && candidateTvl > selectedTvl))
      ) {
        selected = candidate;
      }
      return;
    }

    const group = groups[index]!;
    if (candidate.every((existing) => pricePairDivergenceBps(existing.price, group.price) <= thresholdBps)) {
      visit(index + 1, [...candidate, group]);
    }
    visit(index + 1, candidate);
  }

  visit(0, []);
  return selected;
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
