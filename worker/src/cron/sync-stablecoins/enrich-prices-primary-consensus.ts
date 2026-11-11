import { logWorkerEventArgs } from "../../lib/structured-log";
import {
  getReferencePriceForContext,
  buildPriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/pricing/price-validation";
import { getDexAggregateRejectionReason } from "../../lib/depeg-trust-policy";
import { computePriceConsensus, type SourcePrice } from "../../lib/pricing/price-consensus";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { isHardPricingTrustTier, isListAggregatorOnlyPair } from "@shared/lib/pricing-source-policy";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import {
  buildPrimarySourceCandidates,
  isDexLegWithinCoLegBudget,
  type DlListQuote,
  type PrimaryDexCandidateTelemetry,
  type PrimaryCollectedQuotes,
} from "../../lib/pricing/primary-price-collector";
import type { DexPriceRow, DexPriceSourceLoadTelemetry } from "../../lib/depeg-detection/depeg-helpers";
import type { ValidationContextResolver } from "./pricing";
import type {
  PrimaryConsensusQuoteMaps,
  PrimaryDexPriceSources,
  PrimaryDexRows,
} from "./enrich-prices-primary-provider-collection";
import { isUsableGeckoId, type PeggedAsset, type PriceValidationStats, type PrimaryPriceResult } from "./enrich-prices-shared";

const VUSD_PRIMARY_DEX_AGGREGATE_ID = "vusd-virtue";

function isPrimaryPublicationDexAggregateEligible(
  assetId: string,
  row: DexPriceRow,
  nowSec: number,
): boolean {
  const trustTier = assetId === VUSD_PRIMARY_DEX_AGGREGATE_ID ? "ui" : "depeg";
  const reason = getDexAggregateRejectionReason(row, nowSec, trustTier);
  if (reason != null) logWorkerEventArgs("handler", "info",
    `[primary-prices] dex-aggregate-filter ${JSON.stringify({
      stablecoinId: assetId, reason, tier: trustTier, updatedAt: row.updated_at,
      aggregateObservedAt: row.aggregateObservedAt ?? null, sourceTotalTvl: row.source_total_tvl,
    })}`,
  );
  return reason == null;
}

export function buildPrimaryConsensusResults(params: {
  candidates: PeggedAsset[];
  references?: PriceValidationReferences;
  quoteMaps: PrimaryConsensusQuoteMaps;
  dexRows: PrimaryDexRows;
  dexPriceSources: PrimaryDexPriceSources;
  nowSec: number;
  resolveDlListQuote: (assetId: string) => DlListQuote | undefined;
  results: Map<string, PrimaryPriceResult>;
  stats: PriceValidationStats;
  validationContexts?: ValidationContextResolver;
  dexPriceSourceTelemetry?: DexPriceSourceLoadTelemetry;
}): void {
  logDexPriceSourceLoadTelemetry(params.dexPriceSourceTelemetry);

  for (const asset of params.candidates) {
    // Resolved once per asset: the caller's resolver is a pure dlListPrices
    // read, so the quote feeds both candidate building and the dlPrice field.
    const dlListQuote = params.resolveDlListQuote(asset.id);
    const geckoId = isUsableGeckoId(asset.geckoId) ? asset.geckoId : null;
    const cgQuote = geckoId ? (params.quoteMaps.cgQuotes.get(geckoId) ?? null) : null;
    const cgPrice = cgQuote?.price ?? null;
    // Entries without an upstream observation timestamp resolve to the shared
    // batch local-fetch clock recorded at collection time ("local_fetch" mode).
    const cgObservedAtForAsset = cgQuote != null ? (cgQuote.observedAt ?? params.quoteMaps.cgObservedAt) : null;
    const cgObservedAtModeForAsset =
      cgQuote != null
        ? (cgQuote.observedAtMode ?? (params.quoteMaps.cgObservedAt != null ? "local_fetch" : null))
        : null;

    const collectedQuotes: PrimaryCollectedQuotes = {
      cgPrice,
      cgObservedAt: cgObservedAtForAsset,
      cgObservedAtMode: cgObservedAtModeForAsset,
      cgTickerPrice: params.quoteMaps.cgTickerPrices.get(asset.id) ?? null,
      cgTickerObservedAt: params.quoteMaps.cgTickerObservedAt,
      dlListQuote,
      binancePrice: params.quoteMaps.binancePrices.get(asset.symbol.toUpperCase()) ?? null,
      binanceObservedAt: params.quoteMaps.binanceObservedAt,
      krakenPrice: params.quoteMaps.krakenPrices.get(asset.symbol.toUpperCase()) ?? null,
      krakenObservedAt: params.quoteMaps.krakenObservedAt,
      bitstampPrice: params.quoteMaps.bitstampPrices.get(asset.symbol.toUpperCase()) ?? null,
      bitstampObservedAt: params.quoteMaps.bitstampObservedAtBySymbol.get(asset.symbol.toUpperCase()) ?? null,
      coinbasePrice: params.quoteMaps.coinbasePrices.get(asset.symbol.toUpperCase()) ?? null,
      coinbaseObservedAt: params.quoteMaps.coinbaseObservedAtBySymbol.get(asset.symbol.toUpperCase()) ?? null,
      curvePrice: params.quoteMaps.curvePrices.get(asset.id) ?? null,
      curveObservedAt: params.quoteMaps.curveObservedAtByCoinId.get(asset.id) ?? null,
      curveOraclePrice: params.quoteMaps.curveOraclePrice,
      curveOracleObservedAt: params.quoteMaps.curveOracleObservedAt,
      navQuote: params.quoteMaps.navPrices.get(asset.id),
      hiveNativeQuote: asset.id === "hbd-hive" ? params.quoteMaps.hiveNativeQuote ?? undefined : undefined,
      protocolSources: params.dexPriceSources.get(asset.id),
      dexAggregateQuote: undefined,
    };
    const dexRow = params.dexRows.get(asset.id);
    const eligibleDexAggregate =
      dexRow && isPrimaryPublicationDexAggregateEligible(asset.id, dexRow, params.nowSec) ? dexRow : undefined;
    const context =
      params.validationContexts?.get(asset) ??
      buildPriceValidationContext({
        stablecoinId: String(asset.id),
        pegType: asset.pegType,
        navToken: asset.navToken,
        commodityOunces: asset.commodityOunces,
      });
    const pegRef = context.navToken ? null : getReferencePriceForContext(context, params.references);
    const consensusMode = context.navToken ? "nav" : "fixed";
    const sourceBuildOptions = {
      divergenceThresholdBps: DIVERGENCE_THRESHOLD_BPS,
      nowSec: params.nowSec,
      freshLegsAgree: (legs: readonly SourcePrice[]) => {
        const freshConsensus = computePriceConsensus([...legs], pegRef, DIVERGENCE_THRESHOLD_BPS, { mode: consensusMode });
        // A list-aggregator pair publishes as `single-source` after hardening, so
        // it cannot establish independent fresh-leg agreement here.
        return freshConsensus?.confidence === "high" && !isListAggregatorOnlyPair(freshConsensus.agreeSources);
      },
      fallbackLaneLandsInHardGroup: (legs: readonly SourcePrice[], lane: SourcePrice) => {
        const rejoined = computePriceConsensus([...legs], pegRef, DIVERGENCE_THRESHOLD_BPS, { mode: consensusMode });
        if (rejoined?.confidence !== "high" || !rejoined.agreeSources.includes(lane.source)) return false;
        return rejoined.agreeSources.some((source) =>
          source !== lane.source &&
          isHardPricingTrustTier(getPricingSourceRegistryEntry(source)?.trustTier));
      },
    };
    let sourceBuild = buildPrimarySourceCandidates(asset, collectedQuotes, sourceBuildOptions);
    // As the sole leg the aggregate keeps its own window and publishes as single-source.
    if (
      eligibleDexAggregate &&
      (sourceBuild.sources.length === 0 ||
        isDexLegWithinCoLegBudget(eligibleDexAggregate.aggregateObservedAt!, sourceBuild.sources, params.nowSec))
    ) {
      collectedQuotes.dexAggregateQuote = eligibleDexAggregate;
      sourceBuild = buildPrimarySourceCandidates(asset, collectedQuotes, sourceBuildOptions);
    }
    const {
      sources,
      hasPromotedDexProtocolSource,
      coLegHeldDexSources,
      dexCandidateTelemetry,
      priceSourceConfidenceProfile,
    } = sourceBuild;

    logDexCandidateTelemetry(dexCandidateTelemetry);

    if (hasPromotedDexProtocolSource && !sources.some((source) => source.source.endsWith("-dex"))) {
      const suppressedReasons = [...new Set(dexCandidateTelemetry.flatMap((candidate) =>
        candidate.status === "excluded" &&
        (candidate.reason === "lacked_corroboration" || candidate.reason === "outside_co_leg_budget")
          ? [`${candidate.sourceKey}:${candidate.reason}`]
          : []))];
      logWorkerEventArgs("handler", "info",
        `[primary-prices] ${asset.symbol}: suppressed promoted DEX source(s) (${suppressedReasons.join(", ")})`);
    }

    params.stats.attempted++;

    const consensus = computePriceConsensus(sources, pegRef, DIVERGENCE_THRESHOLD_BPS, { mode: consensusMode });

    if (!consensus) continue;

    params.results.set(asset.id, {
      ...consensus,
      dlPrice: dlListQuote?.price ?? null,
      cgPrice,
      // A lane held out only by the co-leg budget was still read this run: it
      // stays an available, non-voting candidate, so source depth is unchanged.
      candidateSources: [...new Set([...Object.keys(consensus.allPrices), ...coLegHeldDexSources])],
      priceSourceConfidenceProfile,
    });

    if (consensus.confidence === "high") {
      params.stats.high++;
    } else if (consensus.confidence === "single-source") {
      params.stats.singleSource++;
    } else {
      params.stats.low++;
    }

    if (consensus.confidence === "single-source" && consensus.source === "coingecko") {
      params.stats.cgOnly++;
    }

    if (consensus.disagreeSources.length > 0) {
      const highWeightDisagrees = sources
        .filter((source) => source.weight >= 2 && consensus.disagreeSources.includes(source.source))
        .map((source) => `${source.source}($${source.price.toFixed(4)})`);
      if (highWeightDisagrees.length > 0) {
        logWorkerEventArgs("handler", "info",
          `[primary-prices] ${asset.symbol}: high-weight disagree: ${highWeightDisagrees.join(", ")} ` +
            `vs consensus $${consensus.price.toFixed(4)}`,
        );
      }
    }
  }
}

export function logDexPriceSourceLoadTelemetry(telemetry: DexPriceSourceLoadTelemetry | undefined): void {
  if (!telemetry) return;
  for (const row of telemetry.staleRows) {
    logWorkerEventArgs("handler", "info",
      `[primary-prices] dex-source-filter ${JSON.stringify({
        stablecoinId: row.stablecoinId,
        reason: "stale_source_age",
        updatedAt: row.updatedAt,
        ageSec: row.ageSec,
        maxAgeSec: row.maxAgeSec,
      })}`,
    );
  }
  for (const row of telemetry.malformedRows) {
    logWorkerEventArgs("handler", "info",
      `[primary-prices] dex-source-filter ${JSON.stringify({
        stablecoinId: row.stablecoinId,
        reason: "malformed_price_sources_json",
        decodeReason: row.reason,
        updatedAt: row.updatedAt,
      })}`,
    );
  }
}

function logDexCandidateTelemetry(telemetry: PrimaryDexCandidateTelemetry[]): void {
  for (const candidate of telemetry) {
    if (candidate.status !== "excluded") continue;
    logWorkerEventArgs("handler", "info",
      `[primary-prices] dex-candidate-filter ${JSON.stringify({
        stablecoinId: candidate.stablecoinId,
        symbol: candidate.symbol,
        protocol: candidate.protocol,
        sourceKey: candidate.sourceKey,
        chain: candidate.chain,
        price: candidate.price,
        tvl: candidate.tvl,
        updatedAt: candidate.updatedAt,
        reason: candidate.reason,
        thresholdTvlUsd: candidate.thresholdTvlUsd,
        divergenceThresholdBps: candidate.divergenceThresholdBps,
        coLegBudgetSec: candidate.coLegBudgetSec,
        ageSec: candidate.ageSec,
      })}`,
    );
  }
}
