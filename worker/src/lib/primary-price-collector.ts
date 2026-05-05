import type { PriceObservedAtMode, PriceSourceConfidenceProfile } from "@shared/types/core";
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

export type PrimaryDexCandidateExclusionReason =
  | "missing_registry_mapping"
  | "invalid_price"
  | "below_tvl_threshold"
  | "lacked_corroboration";

export interface PrimaryDexCandidateTelemetry {
  stablecoinId: string;
  symbol: string;
  protocol: string;
  sourceKey: string;
  chain: string;
  price: number | null;
  tvl: number | null;
  updatedAt: number | null;
  status: "accepted" | "excluded";
  reason?: PrimaryDexCandidateExclusionReason;
  thresholdTvlUsd?: number;
  divergenceThresholdBps?: number;
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
  dexCandidateTelemetry: PrimaryDexCandidateTelemetry[];
  priceSourceConfidenceProfile: PriceSourceConfidenceProfile | null;
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

const DEX_PROTOCOL_SOURCE_MIN_TVL_USD = 50_000;

function isDexSourceKey(source: string): boolean {
  return source === "dex-promoted" || source.endsWith("-dex");
}

function buildPriceSourceConfidenceProfile(
  sources: SourcePrice[],
  nowSec: number | undefined,
): PriceSourceConfidenceProfile | null {
  const dexSources = sources.filter((source) => isDexSourceKey(source.source));
  if (dexSources.length === 0) return null;

  const protocolLaneSources = dexSources.filter((source) => source.source.endsWith("-dex"));
  const observedAges = nowSec == null
    ? []
    : dexSources
        .map((source) => source.observedAt)
        .filter((observedAt): observedAt is number => (
          typeof observedAt === "number" &&
          Number.isFinite(observedAt) &&
          observedAt > 0 &&
          observedAt <= nowSec
        ))
        .map((observedAt) => nowSec - observedAt);

  return {
    activeDexLanes: protocolLaneSources.length,
    freshestDexLaneAgeSec: observedAges.length > 0 ? Math.min(...observedAges) : null,
    aggregateLaneOnly: dexSources.length === 1 && dexSources[0]?.source === "dex-promoted",
  };
}

export function buildPrimarySourceCandidates(
  asset: PrimaryPriceAssetLike,
  collected: PrimaryCollectedQuotes,
  options?: { divergenceThresholdBps?: number; nowSec?: number },
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

  const dexCandidateTelemetry: PrimaryDexCandidateTelemetry[] = [];
  const promotedDexProtocolSources: SourcePrice[] = [];
  for (const protocolSource of collected.protocolSources ?? []) {
    const sourceKey = `${protocolSource.protocol}-dex`;
    const telemetryBase = {
      stablecoinId: asset.id,
      symbol: asset.symbol,
      protocol: protocolSource.protocol,
      sourceKey,
      chain: protocolSource.chain,
      price: Number.isFinite(protocolSource.price) ? protocolSource.price : null,
      tvl: Number.isFinite(protocolSource.tvl) ? protocolSource.tvl : null,
      updatedAt: Number.isFinite(protocolSource.updatedAt) ? protocolSource.updatedAt : null,
    } satisfies Omit<PrimaryDexCandidateTelemetry, "status" | "reason">;

    if (!getPricingSourceRegistryEntry(sourceKey)) {
      dexCandidateTelemetry.push({
        ...telemetryBase,
        status: "excluded",
        reason: "missing_registry_mapping",
      });
      continue;
    }

    const source = buildSourcePrice({
      source: sourceKey,
      price: protocolSource.price,
      observedAt: protocolSource.updatedAt,
      metadata: { tvl: protocolSource.tvl, chain: protocolSource.chain },
    });
    if (!source) {
      dexCandidateTelemetry.push({
        ...telemetryBase,
        status: "excluded",
        reason: "invalid_price",
      });
      continue;
    }

    if (
      typeof source.metadata?.tvl !== "number" ||
      !Number.isFinite(source.metadata.tvl) ||
      Number(source.metadata.tvl) < DEX_PROTOCOL_SOURCE_MIN_TVL_USD
    ) {
      dexCandidateTelemetry.push({
        ...telemetryBase,
        status: "excluded",
        reason: "below_tvl_threshold",
        thresholdTvlUsd: DEX_PROTOCOL_SOURCE_MIN_TVL_USD,
      });
      continue;
    }

    promotedDexProtocolSources.push(source);
  }

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
    for (const source of promotedDexProtocolSources) {
      const sourceProtocol = source.source.replace(/-dex$/, "");
      const matchingInput = (collected.protocolSources ?? []).find((entry) => entry.protocol === sourceProtocol);
      dexCandidateTelemetry.push({
        stablecoinId: asset.id,
        symbol: asset.symbol,
        protocol: sourceProtocol,
        sourceKey: source.source,
        chain: typeof source.metadata?.chain === "string" ? source.metadata.chain : matchingInput?.chain ?? "unknown",
        price: source.price,
        tvl: typeof source.metadata?.tvl === "number" ? source.metadata.tvl : matchingInput?.tvl ?? null,
        updatedAt: source.observedAt ?? matchingInput?.updatedAt ?? null,
        status: "accepted",
      });
    }
  } else if (hasPromotedDexProtocolSource) {
    for (const source of promotedDexProtocolSources) {
      const sourceProtocol = source.source.replace(/-dex$/, "");
      const matchingInput = (collected.protocolSources ?? []).find((entry) => entry.protocol === sourceProtocol);
      dexCandidateTelemetry.push({
        stablecoinId: asset.id,
        symbol: asset.symbol,
        protocol: sourceProtocol,
        sourceKey: source.source,
        chain: typeof source.metadata?.chain === "string" ? source.metadata.chain : matchingInput?.chain ?? "unknown",
        price: source.price,
        tvl: typeof source.metadata?.tvl === "number" ? source.metadata.tvl : matchingInput?.tvl ?? null,
        updatedAt: source.observedAt ?? matchingInput?.updatedAt ?? null,
        status: "excluded",
        reason: "lacked_corroboration",
        divergenceThresholdBps,
      });
    }
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
    dexCandidateTelemetry,
    priceSourceConfidenceProfile: buildPriceSourceConfidenceProfile(sources, options?.nowSec),
  };
}
