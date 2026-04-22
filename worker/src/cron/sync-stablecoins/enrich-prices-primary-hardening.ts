import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { PriceValidationContext, PriceValidationReferences } from "../../lib/price-validation";
import {
  buildPriceValidationContext,
  isSevereFixedPegDownside,
} from "../../lib/price-validation";
import { DEX_FRESHNESS_SEC, POOL_CHALLENGE_MIN_TVL, getDepegThresholdBps } from "../../lib/constants";
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
    if (result.agreeSources.length !== 2) continue;
    const allListAggregator = result.agreeSources.every(
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
    const preserveCorroboratedSevereDownside = hasCorroboratedSevereDownsideCandidate(
      assetId,
      result,
      pegType,
      references,
      validationContexts?.get(assetId),
    );

    // Evaluate divergence from one protocol-level price, not from any single pool.
    // A rogue pool inside an otherwise agreeing protocol should not count as
    // independent corroboration for replacing the published price.
    const divergingProtocolGroups = protocolGroups.filter((group) => {
      const mid = (result.price + group.price) / 2;
      if (mid <= 0) return false;
      const bps = Math.abs(result.price - group.price) / mid * 10_000;
      return bps >= poolChallengeBps;
    });
    if (divergingProtocolGroups.length > 0) {
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

      if (divergingProtocolGroups.length >= 2 && !preserveCorroboratedSevereDownside) {
        const replacementPrice = computeWeightedMedianPrice(
          divergingProtocolGroups.map((group) => ({
            price: group.price,
            weight: group.tvl,
          })),
        );
        if (replacementPrice != null) {
          result.price = replacementPrice;
          result.source = "pool-tvl-weighted";
          result.selectedSource = "pool-tvl-weighted";
          result.priceEstimator = "selected_source";
          const poolObservedAts = divergingProtocolGroups
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
