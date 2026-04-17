import type { PriceObservedAtMode } from "@shared/types/core";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import type { SourcePrice } from "./price-consensus";

interface PrimaryPriceAssetLike {
  id: string;
  symbol: string;
  geckoId?: string | null;
}

interface PythQuote {
  price: number;
  confidenceBps: number;
  publishTime: number;
}

interface RedstoneQuote {
  price: number;
  venueCount: number;
  venueAgreementPct: number;
  timestamp: number;
}

interface DexProtocolSourceQuote {
  protocol: string;
  price: number;
  tvl: number;
  updatedAt: number;
  chain: string;
}

interface DexAggregateQuote {
  dex_price_usd: number;
  updated_at: number;
  source_pool_count: number;
  source_total_tvl: number;
}

export interface DlListQuote {
  price: number;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

export interface PrimaryCollectedQuotes {
  cgPrice: number | null;
  cgObservedAt: number | null;
  cgObservedAtMode: PriceObservedAtMode | null;
  cgTickerPrice: number | null;
  cgTickerObservedAt: number | null;
  dlListQuote?: DlListQuote;
  pythQuote?: PythQuote;
  binancePrice: number | null;
  binanceObservedAt: number | null;
  krakenPrice: number | null;
  krakenObservedAt: number | null;
  bitstampPrice: number | null;
  bitstampObservedAt: number | null;
  coinbasePrice: number | null;
  coinbaseObservedAt: number | null;
  redstoneQuote?: RedstoneQuote;
  curvePrice: number | null;
  curveObservedAt: number | null;
  curveOraclePrice: number | null;
  curveOracleObservedAt: number | null;
  protocolSources?: DexProtocolSourceQuote[];
  dexAggregateQuote?: DexAggregateQuote;
}

export interface PrimarySourceBuildResult {
  sources: SourcePrice[];
  hasPromotedDexProtocolSource: boolean;
}

function buildSourcePrice(input: {
  source: string;
  price: number | null | undefined;
  weight?: number;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  metadata?: Record<string, unknown>;
}): SourcePrice | null {
  if (typeof input.price !== "number" || !Number.isFinite(input.price) || input.price <= 0) {
    return null;
  }

  const registryEntry = getPricingSourceRegistryEntry(input.source);
  return {
    source: input.source,
    price: input.price,
    weight: input.weight ?? registryEntry?.defaultWeight ?? 1,
    observedAt: input.observedAt ?? null,
    observedAtMode: input.observedAtMode ?? registryEntry?.defaultObservedAtMode ?? null,
    metadata: input.metadata,
  };
}

function getAdjustedPythWeight(confidenceBps: number, baseWeight: number): number {
  if (!Number.isFinite(confidenceBps) || confidenceBps < 0) {
    return baseWeight;
  }
  if (confidenceBps >= 250) {
    return 0;
  }

  const confidencePenalty = Math.min(0.85, confidenceBps / 250);
  const adjustedWeight = baseWeight * (1 - confidencePenalty);
  return Math.max(0.25, Number(adjustedWeight.toFixed(3)));
}

function pricesAgreeWithinBps(left: number, right: number, thresholdBps: number): boolean {
  const mid = (left + right) / 2;
  if (mid <= 0) return false;
  return (Math.abs(left - right) / mid) * 10_000 <= thresholdBps;
}

export function buildPrimarySourceCandidates(
  asset: PrimaryPriceAssetLike,
  collected: PrimaryCollectedQuotes,
  options?: { divergenceThresholdBps?: number },
): PrimarySourceBuildResult {
  const divergenceThresholdBps = options?.divergenceThresholdBps ?? DIVERGENCE_THRESHOLD_BPS;
  const sources: SourcePrice[] = [];

  const baseSources = [
    buildSourcePrice({
      source: "coingecko",
      price: collected.cgPrice,
      observedAt: collected.cgObservedAt,
      observedAtMode: collected.cgObservedAtMode,
    }),
    buildSourcePrice({
      source: "cg-ticker",
      price: collected.cgTickerPrice,
      observedAt: collected.cgTickerObservedAt,
    }),
    buildSourcePrice({
      source: "defillama-list",
      price: collected.dlListQuote?.price ?? null,
      observedAt: collected.dlListQuote?.observedAt ?? null,
      observedAtMode: collected.dlListQuote?.observedAtMode ?? "unknown",
    }),
    buildSourcePrice({
      source: "binance",
      price: collected.binancePrice,
      observedAt: collected.binanceObservedAt,
    }),
    buildSourcePrice({
      source: "kraken",
      price: collected.krakenPrice,
      observedAt: collected.krakenObservedAt,
    }),
    buildSourcePrice({
      source: "bitstamp",
      price: collected.bitstampPrice,
      observedAt: collected.bitstampObservedAt,
    }),
    buildSourcePrice({
      source: "coinbase",
      price: collected.coinbasePrice,
      observedAt: collected.coinbaseObservedAt,
    }),
    buildSourcePrice({
      source: "curve-onchain",
      price: collected.curvePrice,
      observedAt: collected.curveObservedAt,
    }),
    buildSourcePrice({
      source: "curve-oracle",
      price: asset.id === "crvusd-curve" ? collected.curveOraclePrice : null,
      observedAt: collected.curveOracleObservedAt,
      observedAtMode: "upstream",
    }),
  ].filter((source): source is SourcePrice => source != null);
  sources.push(...baseSources);

  const pythQuote = collected.pythQuote;
  if (pythQuote) {
    const pythWeight = getAdjustedPythWeight(
      pythQuote.confidenceBps,
      getPricingSourceRegistryEntry("pyth")?.defaultWeight ?? 2,
    );
    const pythSource = buildSourcePrice({
      source: "pyth",
      price: pythQuote.price,
      weight: pythWeight,
      observedAt: pythQuote.publishTime,
      metadata: { confidenceBps: pythQuote.confidenceBps },
    });
    if (pythSource && pythSource.weight > 0) {
      sources.push(pythSource);
    }
  }

  const redstoneQuote = collected.redstoneQuote;
  if (redstoneQuote && redstoneQuote.venueCount >= 2 && redstoneQuote.venueAgreementPct >= 60) {
    const redstoneSource = buildSourcePrice({
      source: "redstone",
      price: redstoneQuote.price,
      observedAt: redstoneQuote.timestamp,
      metadata: {
        venueCount: redstoneQuote.venueCount,
        venueAgreementPct: redstoneQuote.venueAgreementPct,
      },
    });
    if (redstoneSource) {
      sources.push(redstoneSource);
    }
  }

  const promotedDexProtocolSources = (collected.protocolSources ?? [])
    .map((protocolSource) => {
      const sourceKey = `${protocolSource.protocol}-dex`;
      if (!getPricingSourceRegistryEntry(sourceKey)) return null;
      return buildSourcePrice({
        source: sourceKey,
        price: protocolSource.price,
        observedAt: protocolSource.updatedAt,
        metadata: { tvl: protocolSource.tvl, chain: protocolSource.chain },
      });
    })
    .filter((source): source is SourcePrice => (
      source != null &&
      typeof source.metadata?.tvl === "number" &&
      Number(source.metadata.tvl) >= 50_000
    ));

  const hasPromotedDexProtocolSource = promotedDexProtocolSources.length > 0;
  const hardTrustTiers = new Set(["hard_market", "hard_oracle", "hard_protocol"]);
  const hasHardCorroborator = sources.some((source) => {
    const tier = getPricingSourceRegistryEntry(source.source)?.trustTier;
    return tier != null && hardTrustTiers.has(tier);
  });
  const hasDexCorroboration =
    promotedDexProtocolSources.length > 1 ||
    sources.length === 0 ||
    (hasHardCorroborator && promotedDexProtocolSources.some((dexSource) =>
      sources.some((source) => {
        const tier = getPricingSourceRegistryEntry(source.source)?.trustTier;
        return tier != null && hardTrustTiers.has(tier) && pricesAgreeWithinBps(dexSource.price, source.price, divergenceThresholdBps);
      })
    ));

  if (hasPromotedDexProtocolSource && hasDexCorroboration) {
    sources.push(...promotedDexProtocolSources);
  }

  if (collected.dexAggregateQuote && !hasPromotedDexProtocolSource) {
    const dexAggregateSource = buildSourcePrice({
      source: "dex-promoted",
      price: collected.dexAggregateQuote.dex_price_usd,
      observedAt: collected.dexAggregateQuote.updated_at,
      metadata: {
        poolCount: collected.dexAggregateQuote.source_pool_count,
        tvl: collected.dexAggregateQuote.source_total_tvl,
      },
    });
    if (dexAggregateSource) {
      sources.push(dexAggregateSource);
    }
  }

  return {
    sources,
    hasPromotedDexProtocolSource,
  };
}
