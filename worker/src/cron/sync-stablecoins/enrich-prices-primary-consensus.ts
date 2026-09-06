import { logWorkerEventArgs } from "../../lib/structured-log";
import {
  getReferencePriceForContext,
  buildPriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/price-validation";
import { isTrustedDexPriceRow } from "../../lib/depeg-trust-policy";
import { computePriceConsensus } from "../../lib/price-consensus";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import {
  buildPrimarySourceCandidates,
  type DlListQuote,
  type PrimaryDexCandidateTelemetry,
  type PrimaryCollectedQuotes,
} from "../../lib/primary-price-collector";
import type { DexPriceRow, DexPriceSourceLoadTelemetry } from "../../lib/depeg-helpers";
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
  return isTrustedDexPriceRow(row, nowSec, trustTier);
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
      redstoneQuote: params.quoteMaps.redstonePrices.get(asset.id),
      curvePrice: params.quoteMaps.curvePrices.get(asset.id) ?? null,
      curveObservedAt: params.quoteMaps.curveObservedAtByCoinId.get(asset.id) ?? null,
      curveOraclePrice: params.quoteMaps.curveOraclePrice,
      curveOracleObservedAt: params.quoteMaps.curveOracleObservedAt,
      navQuote: params.quoteMaps.navPrices.get(asset.id),
      protocolSources: params.dexPriceSources.get(asset.id),
      dexAggregateQuote: (() => {
        const dexRow = params.dexRows.get(asset.id);
        return dexRow && isPrimaryPublicationDexAggregateEligible(asset.id, dexRow, params.nowSec)
          ? dexRow
          : undefined;
      })(),
    };

    const { sources, hasPromotedDexProtocolSource, dexCandidateTelemetry, priceSourceConfidenceProfile } =
      buildPrimarySourceCandidates(asset, collectedQuotes, {
        divergenceThresholdBps: DIVERGENCE_THRESHOLD_BPS,
        nowSec: params.nowSec,
      });

    logDexCandidateTelemetry(dexCandidateTelemetry);

    if (hasPromotedDexProtocolSource && !sources.some((source) => source.source.endsWith("-dex"))) {
      logWorkerEventArgs("handler", "info", `[primary-prices] ${asset.symbol}: suppressed promoted DEX source(s) that lacked corroboration`);
    }

    params.stats.attempted++;

    const context =
      params.validationContexts?.get(asset) ??
      buildPriceValidationContext({
        stablecoinId: String(asset.id),
        pegType: asset.pegType,
        navToken: asset.navToken,
        commodityOunces: asset.commodityOunces,
      });
    const pegRef = context.navToken ? null : getReferencePriceForContext(context, params.references);
    const consensus = computePriceConsensus(sources, pegRef, DIVERGENCE_THRESHOLD_BPS, {
      mode: context.navToken ? "nav" : "fixed",
    });

    if (!consensus) continue;

    params.results.set(asset.id, {
      price: consensus.price,
      source: consensus.source,
      selectedSource: consensus.selectedSource,
      priceEstimator: consensus.priceEstimator,
      confidence: consensus.confidence,
      dlPrice: dlListQuote?.price ?? null,
      cgPrice,
      candidateSources: Object.keys(consensus.allPrices),
      agreeSources: consensus.agreeSources,
      disagreeSources: consensus.disagreeSources,
      allPrices: consensus.allPrices,
      observedAt: consensus.observedAt,
      observedAtMode: consensus.observedAtMode,
      observedAtBySource: consensus.observedAtBySource,
      observedAtModeBySource: consensus.observedAtModeBySource,
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
      })}`,
    );
  }
}
