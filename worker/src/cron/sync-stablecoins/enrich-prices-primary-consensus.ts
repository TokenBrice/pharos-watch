import { logWorkerEventArgs } from "../../lib/structured-log";
import { evaluateCoingeckoMicroVolumeOutlier } from "../../lib/coingecko-simple-price";
import { evaluateHiveCgDivergenceVeto, HIVE_MARKET_POLICY } from "../../lib/hive-market-price";
import {
  createPricingAssetAttempt,
  MAX_ASSET_ATTEMPTS_PER_DIAGNOSTIC,
  type PricingAssetAttemptRecord,
  type PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";
import {
  getReferencePriceForContext,
  validatePriceCandidate,
  FIAT_UPPER_BAND_REQUIRES_CORROBORATION,
  buildPriceValidationContext,
  type PriceValidationReferences,
} from "../../lib/price-validation";
import { getDexAggregateRejectionReason } from "../../lib/depeg-trust-policy";
import { computePriceConsensus, type SourcePrice } from "../../lib/price-consensus";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import {
  CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC,
  COINGECKO_MICRO_VOLUME_MIN_USD,
  COINGECKO_MICRO_VOLUME_OUTLIER_MAX_DEVIATION_BPS,
  isHardPricingTrustTier,
  isListAggregatorOnlyPair,
} from "@shared/lib/pricing-source-policy";
import { matchesCuratedKrakenAsset } from "@shared/lib/pricing-provider-config";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { validatePricingSourceFreshness } from "../../lib/pricing-source-freshness";
import {
  buildPrimarySourceCandidates,
  isDexLegWithinCoLegBudget,
  type DlListQuote,
  type PrimaryDexCandidateTelemetry,
  type PrimaryCollectedQuotes,
} from "../../lib/primary-price-collector";
import type { DexPriceRow, DexPriceSourceLoadTelemetry } from "../../lib/depeg-helpers";
import { isCanonicalPricePoolKey } from "@shared/lib/pricing-source-pool-provenance";
import type { PrimaryPriceWithFiatPremiumEvidence, ValidationContextResolver } from "./pricing";
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
  providerDiagnostics?: PricingProviderAttemptDiagnostic[];
  rejectedCgReasons?: Map<string, string>;
}): void {
  logDexPriceSourceLoadTelemetry(params.dexPriceSourceTelemetry);

  const cgAssetAttempts: PricingAssetAttemptRecord[] = [];
  let cgCandidateCount = 0;
  let cgResolvedCount = 0;
  let cgVolumeUnavailableCount = 0;
  let cgRejectedCount = 0;
  const hiveDiagnostic = params.providerDiagnostics?.find((d) => d.source === "hive-native-cg")?.nativeMarket;

  for (const asset of params.candidates) {
    // Resolved once per asset: the caller's resolver is a pure dlListPrices
    // read, so the quote feeds both candidate building and the dlPrice field.
    const dlListQuote = params.resolveDlListQuote(asset.id);
    const geckoId = isUsableGeckoId(asset.geckoId) ? asset.geckoId : null;
    const cgQuote = geckoId ? (params.quoteMaps.cgQuotes.get(geckoId) ?? null) : null;
    const rawCgPrice = cgQuote?.price ?? null;
    const context =
      params.validationContexts?.get(asset) ??
      buildPriceValidationContext({
        stablecoinId: String(asset.id),
        pegType: asset.pegType,
        navToken: asset.navToken,
        commodityOunces: asset.commodityOunces,
      });
    const pegRef = context.navToken ? null : getReferencePriceForContext(context, params.references);

    let cgPrice: number | null = cgQuote?.observedAtMode === "upstream" ? rawCgPrice : null;
    if (cgPrice != null && cgQuote != null) {
      cgCandidateCount++;
      const microVolCheck = evaluateCoingeckoMicroVolumeOutlier({
        price: cgPrice,
        volume24hUsd: cgQuote.volume24hUsd,
        context,
        references: params.references,
      });
      if (microVolCheck.status === "volume_unavailable") {
        cgVolumeUnavailableCount++;
        params.stats.cgVolumeUnavailable = (params.stats.cgVolumeUnavailable ?? 0) + 1;
      } else if (microVolCheck.status === "rejected") {
        cgPrice = null;
        cgRejectedCount++;
        params.stats.cgMicroVolumeRejected = (params.stats.cgMicroVolumeRejected ?? 0) + 1;
        params.rejectedCgReasons?.set(asset.id, microVolCheck.reason);
        cgAssetAttempts.push(createPricingAssetAttempt({
          assetId: asset.id,
          adapter: "coingecko",
          source: "coingecko",
          state: "attempted",
          result: "rejected",
          rejectionClass: microVolCheck.reason,
          candidateAt: params.nowSec,
          observedAt: cgQuote.observedAt ?? null,
        }));
        logWorkerEventArgs("handler", "warn",
          `[primary-prices] coingecko-quote-filter ${JSON.stringify({
            stablecoinId: asset.id,
            symbol: asset.symbol,
            reason: microVolCheck.reason,
            price: rawCgPrice,
            referencePrice: microVolCheck.referencePrice,
            deviationBps: Math.round(microVolCheck.deviationBps),
            volume24hUsd: microVolCheck.volume24hUsd,
            minVolumeUsd: COINGECKO_MICRO_VOLUME_MIN_USD,
            maxDeviationBps: COINGECKO_MICRO_VOLUME_OUTLIER_MAX_DEVIATION_BPS,
          })}`,
        );
      }
    }

    if (asset.id === "hbd-hive") {
      const hiveVetoPrice = params.quoteMaps.hiveVetoMid?.price ?? params.quoteMaps.hiveNativeQuote?.price ?? null;
      if (cgPrice != null) {
        const veto = evaluateHiveCgDivergenceVeto({
          cgPrice,
          hiveVetoMid: hiveVetoPrice,
          unavailableReason: params.quoteMaps.hiveVetoUnavailableReason,
        });
        if (veto.status === "vetoed") {
          cgPrice = null;
          cgRejectedCount++;
          params.stats.hiveDivergenceVetoed = (params.stats.hiveDivergenceVetoed ?? 0) + 1;
          params.rejectedCgReasons?.set(asset.id, veto.reason);
          cgAssetAttempts.push(createPricingAssetAttempt({
            assetId: asset.id,
            adapter: "coingecko",
            source: "coingecko",
            state: "attempted",
            result: "rejected",
            rejectionClass: veto.reason,
            candidateAt: params.nowSec,
            observedAt: cgQuote?.observedAt ?? null,
          }));
          if (hiveDiagnostic) {
            hiveDiagnostic.vetoStatus = "vetoed";
            hiveDiagnostic.vetoReason = veto.reason;
            hiveDiagnostic.vetoDivergenceBps = Math.round(veto.divergenceBps);
          }
          logWorkerEventArgs("handler", "warn",
            `[primary-prices] hbd-hive-veto ${JSON.stringify({
              stablecoinId: asset.id,
              reason: veto.reason,
              cgPrice: rawCgPrice,
              hiveMidPrice: veto.hiveMidPrice,
              divergenceBps: Math.round(veto.divergenceBps),
              maxDivergenceBps: HIVE_MARKET_POLICY.cgDivergenceVetoMaxBps,
            })}`,
          );
        } else if (veto.status === "agreed") {
          if (hiveDiagnostic) {
            hiveDiagnostic.vetoStatus = "agreed";
            hiveDiagnostic.vetoReason = null;
            hiveDiagnostic.vetoDivergenceBps = Math.round(veto.divergenceBps);
          }
        } else {
          params.stats.hiveVetoUnavailable = (params.stats.hiveVetoUnavailable ?? 0) + 1;
          if (hiveDiagnostic) {
            hiveDiagnostic.vetoStatus = "unavailable";
            hiveDiagnostic.vetoReason = veto.reason;
            hiveDiagnostic.vetoDivergenceBps = null;
          }
          logWorkerEventArgs("handler", "info",
            `[primary-prices] hbd-hive-veto-unavailable ${JSON.stringify({
              stablecoinId: asset.id,
              reason: veto.reason,
            })}`,
          );
        }
      } else if (hiveDiagnostic) {
        hiveDiagnostic.vetoStatus = hiveVetoPrice != null ? "no_cg_quote" : "unavailable";
        hiveDiagnostic.vetoReason = hiveVetoPrice != null
          ? null
          : (params.quoteMaps.hiveVetoUnavailableReason ?? "hive_market_unavailable");
        hiveDiagnostic.vetoDivergenceBps = null;
      }
    }

    if (cgPrice != null) {
      cgResolvedCount++;
    }

    const symbol = asset.symbol.toUpperCase();
    const krakenAllowedForAsset = matchesCuratedKrakenAsset(symbol, asset.id);
    const krakenUpstreamObservedAt = krakenAllowedForAsset
      ? params.quoteMaps.krakenObservedAtBySymbol.get(symbol)
      : undefined;
    const hasKrakenUpstreamClock = krakenUpstreamObservedAt != null;
    // The depth book may age out while the remaining providers are collected;
    // a stale book stays rejected and is never re-clocked to local fetch time.
    const freshKrakenUpstreamClock = hasKrakenUpstreamClock && validatePricingSourceFreshness({
      source: "kraken",
      observedAt: krakenUpstreamObservedAt,
      observedAtMode: "upstream",
      nowSec: params.nowSec,
      requireObservedAt: true,
      maxFutureSkewSec: CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC,
    }).accepted ? krakenUpstreamObservedAt : undefined;
    const collectedQuotes: PrimaryCollectedQuotes = {
      cgPrice,
      cgObservedAt: cgQuote?.observedAt ?? null,
      cgObservedAtMode: cgQuote?.observedAtMode ?? null,
      dlListQuote,
      binancePrice: params.quoteMaps.binancePrices.get(asset.symbol.toUpperCase()) ?? null,
      binanceObservedAt: params.quoteMaps.binanceObservedAt,
      krakenPrice: !krakenAllowedForAsset
        ? null
        : hasKrakenUpstreamClock
          ? (freshKrakenUpstreamClock != null ? (params.quoteMaps.krakenPrices.get(symbol) ?? null) : null)
          : (params.quoteMaps.krakenPrices.get(symbol) ?? null),
      krakenObservedAt: !krakenAllowedForAsset || hasKrakenUpstreamClock ? null : params.quoteMaps.krakenObservedAt,
      krakenMarketObservedAt: freshKrakenUpstreamClock,
      krakenQuoteBasis: !krakenAllowedForAsset
        ? undefined
        : hasKrakenUpstreamClock
          ? (freshKrakenUpstreamClock != null ? "bid-ask-midpoint" : undefined)
          : params.quoteMaps.krakenQuoteBasisBySymbol.get(symbol),
      bitstampPrice: params.quoteMaps.bitstampPrices.get(asset.symbol.toUpperCase()) ?? null,
      bitstampObservedAt: params.quoteMaps.bitstampObservedAtBySymbol.get(asset.symbol.toUpperCase()) ?? null,
      coinbasePrice: params.quoteMaps.coinbasePrices.get(asset.symbol.toUpperCase()) ?? null,
      coinbaseObservedAt: params.quoteMaps.coinbaseObservedAtBySymbol.get(asset.symbol.toUpperCase()) ?? null,
      curvePrice: params.quoteMaps.curvePrices.get(asset.id) ?? null,
      curveObservedAt: params.quoteMaps.curveObservedAtByCoinId.get(asset.id) ?? null,
      curvePricePoolKeys: params.quoteMaps.curvePricePoolKeysByCoinId.get(asset.id),
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
    const votingSources = sourceBuild.sources.filter((source) => source.nonVotingReason == null);
    // As the sole leg the aggregate keeps its own window and publishes as single-source.
    if (
      eligibleDexAggregate &&
      (votingSources.length === 0 ||
        isDexLegWithinCoLegBudget(eligibleDexAggregate.aggregateObservedAt!, votingSources, params.nowSec))
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

    const result: PrimaryPriceWithFiatPremiumEvidence = {
      ...consensus,
      dlPrice: dlListQuote?.price ?? null,
      cgPrice,
      // A lane held out only by the co-leg budget was still read this run: it
      // stays an available, non-voting candidate, so source depth is unchanged.
      candidateSources: [...new Set([
        ...Object.keys(consensus.allPrices), ...Object.keys(consensus.diagnosticPrices ?? {}), ...coLegHeldDexSources,
      ])],
      priceSourceConfidenceProfile,
    };
    if (consensus.priceEstimator === "selected_source" && consensus.selectedSource === "kraken") {
      result.priceQuoteBasis = collectedQuotes.krakenQuoteBasis;
    }
    const needsPremiumEvidence = context.pegClass === "fiat_fx" &&
      validatePriceCandidate(consensus.price, context, "primary_authoritative", params.references).reasonCode === FIAT_UPPER_BAND_REQUIRES_CORROBORATION;
    if (needsPremiumEvidence || consensus.observedAt != null) {
      const inputs = params.dexPriceSources.get(asset.id) ?? [];
      const evidence = sources.flatMap((quote) => {
        const at = quote.observedAt;
        if (sources.some((other) => other !== quote && !other.nonVotingReason && other.source === quote.source &&
          other.observedAt === at && other.price === quote.price)) return [];
        if (quote.nonVotingReason || !at || consensus.observedAtBySource[quote.source] !== at ||
          consensus.allPrices[quote.source] !== quote.price) return [];
        let upstreamKeys: readonly string[] | undefined;
        if (quote.source === "dex-promoted") {
          upstreamKeys = eligibleDexAggregate?.upstreamKeys;
        } else if (quote.source.endsWith("-dex")) {
          const matching = inputs.filter((row) => `${row.protocol}-dex` === quote.source &&
            row.price === quote.price && row.observedAt === at && row.pricePoolKeys === quote.metadata?.pricePoolKeys);
          if (matching.length === 1) upstreamKeys = matching[0]?.upstreamKeys;
        } else if (quote.source === "curve-onchain" || quote.observedAtMode === "upstream") {
          upstreamKeys = quote.upstreamKeys;
        }
        return upstreamKeys?.length
          ? [[quote.source, { priceUsd: quote.price, observedAtSec: at, upstreamKeys }] as const] : [];
      });
      const bySource = Object.fromEntries(evidence);
      if (needsPremiumEvidence) result.fiatPremiumEvidence = bySource;
      const selected = consensus.priceEstimator === "cluster_median" ? consensus.agreeSources : [consensus.selectedSource];
      if (consensus.observedAt != null && selected.length && selected.every((key) => bySource[key]?.upstreamKeys.length)) {
        result.upstreamKeys = [...new Set(selected.flatMap((key) => bySource[key]!.upstreamKeys))].sort();
        const pools = result.upstreamKeys.filter(isCanonicalPricePoolKey);
        if (pools.length) result.pricePoolKeys = pools;
      }
    }
    params.results.set(asset.id, result);

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
        .filter((source) => (source.weight >= 2 || source.nonVotingReason) && consensus.disagreeSources.includes(source.source))
        .map((source) => `${source.source}($${source.price.toFixed(4)})`);
      if (highWeightDisagrees.length > 0) {
        logWorkerEventArgs("handler", "info",
          `[primary-prices] ${asset.symbol}: high-weight disagree: ${highWeightDisagrees.join(", ")} ` +
            `vs consensus $${consensus.price.toFixed(4)}`,
        );
      }
    }
  }

  if (params.providerDiagnostics && (cgAssetAttempts.length > 0 || cgVolumeUnavailableCount > 0)) {
    params.providerDiagnostics.push({
      source: "coingecko",
      stage: "primary",
      endpoint: "api.coingecko.com/api/v3/simple/price",
      status: 200,
      ok: true,
      success: true,
      candidateCount: cgCandidateCount,
      resolvedCount: cgResolvedCount,
      ...(cgRejectedCount > 0 ? { rejectionReasonCounts: { "price-rejected": cgRejectedCount } } : {}),
      ...(cgAssetAttempts.length > 0
        ? { assetAttempts: cgAssetAttempts.slice(0, MAX_ASSET_ATTEMPTS_PER_DIAGNOSTIC) }
        : {}),
    });
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
