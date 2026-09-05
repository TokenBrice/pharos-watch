import type { PriceObservedAtMode, PriceSourceConfidenceProfile } from "@shared/types/core";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { pricesAgreeWithinBps } from "./price-divergence";
import type { SourcePrice } from "./price-consensus";
import { validatePricingSourceFreshness, type PricingSourceFreshnessRejectReason } from "./pricing-source-freshness";

interface PrimaryPriceAssetLike {
  id: string;
  symbol: string;
  geckoId?: string | null;
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

export interface NavTelemetryQuote {
  source: "chainlink-nav" | "superstate-liquidity";
  price: number;
  observedAt: number;
  observedAtMode?: PriceObservedAtMode | null;
  metadata?: Record<string, unknown>;
}

export type PrimaryDexCandidateExclusionReason =
  | "missing_registry_mapping"
  | "invalid_price"
  | "below_tvl_threshold"
  | "lacked_corroboration"
  | "stale_source_age"
  | "future_source_timestamp"
  | "missing_observed_at"
  | "invalid_observed_at";

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

function buildPromotedDexCandidateTelemetry(
  asset: PrimaryPriceAssetLike,
  source: SourcePrice,
  matchingInput: DexProtocolSourceQuote | undefined,
  outcome: Pick<PrimaryDexCandidateTelemetry, "status"> &
    Partial<Pick<PrimaryDexCandidateTelemetry, "reason" | "divergenceThresholdBps">>,
): PrimaryDexCandidateTelemetry {
  const sourceProtocol = source.source.replace(/-dex$/, "");
  return {
    stablecoinId: asset.id,
    symbol: asset.symbol,
    protocol: sourceProtocol,
    sourceKey: source.source,
    chain: typeof source.metadata?.chain === "string" ? source.metadata.chain : (matchingInput?.chain ?? "unknown"),
    price: source.price,
    tvl: typeof source.metadata?.tvl === "number" ? source.metadata.tvl : (matchingInput?.tvl ?? null),
    updatedAt: source.observedAt ?? matchingInput?.updatedAt ?? null,
    ...outcome,
  };
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
  navQuote?: NavTelemetryQuote;
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
  nowSec?: number;
  metadata?: Record<string, unknown>;
}): SourcePrice | null {
  if (typeof input.price !== "number" || !Number.isFinite(input.price) || input.price <= 0) {
    return null;
  }

  const registryEntry = getPricingSourceRegistryEntry(input.source);
  const freshness = validatePricingSourceFreshness({
    source: input.source,
    observedAt: input.observedAt,
    observedAtMode: input.observedAtMode,
    nowSec: input.nowSec,
  });
  if (!freshness.accepted) {
    return null;
  }

  return {
    source: input.source,
    price: input.price,
    weight: input.weight ?? registryEntry?.defaultWeight ?? 1,
    observedAt: freshness.observedAt,
    observedAtMode: freshness.observedAtMode,
    metadata: input.metadata,
  };
}

const DEX_PROTOCOL_SOURCE_MIN_TVL_USD = 50_000;

function isDexSourceKey(source: string): boolean {
  return source === "dex-promoted" || source.endsWith("-dex");
}

function hasBinanceDexBridgeOverlap(collected: PrimaryCollectedQuotes): boolean {
  return (
    collected.binancePrice != null &&
    (collected.protocolSources ?? []).some((source) => source.protocol.trim().toLowerCase() === "binance")
  );
}

function mapFreshnessReasonToDexExclusion(
  reason: PricingSourceFreshnessRejectReason,
): PrimaryDexCandidateExclusionReason {
  switch (reason) {
    case "stale_observed_at":
      return "stale_source_age";
    case "future_observed_at":
      return "future_source_timestamp";
    case "missing_observed_at":
      return "missing_observed_at";
    case "invalid_observed_at":
      return "invalid_observed_at";
    case "unknown_source":
      return "missing_registry_mapping";
  }
}

function buildPriceSourceConfidenceProfile(
  sources: SourcePrice[],
  nowSec: number | undefined,
): PriceSourceConfidenceProfile | null {
  const dexSources = sources.filter((source) => isDexSourceKey(source.source));
  if (dexSources.length === 0) return null;

  const protocolLaneSources = dexSources.filter((source) => source.source.endsWith("-dex"));
  const observedAges =
    nowSec == null
      ? []
      : dexSources
          .map((source) => source.observedAt)
          .filter(
            (observedAt): observedAt is number =>
              typeof observedAt === "number" && Number.isFinite(observedAt) && observedAt > 0 && observedAt <= nowSec,
          )
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
  const nowSec = options?.nowSec;
  const sources: SourcePrice[] = [];

  const baseSources = [
    buildSourcePrice({
      source: "coingecko",
      price: collected.cgPrice,
      observedAt: collected.cgObservedAt,
      observedAtMode: collected.cgObservedAtMode,
      nowSec,
    }),
    buildSourcePrice({
      source: "cg-ticker",
      price: collected.cgTickerPrice,
      observedAt: collected.cgTickerObservedAt,
      nowSec,
    }),
    buildSourcePrice({
      source: "defillama-list",
      price: collected.dlListQuote?.price ?? null,
      observedAt: collected.dlListQuote?.observedAt ?? null,
      observedAtMode: collected.dlListQuote?.observedAtMode ?? "unknown",
      nowSec,
    }),
    buildSourcePrice({
      source: "binance",
      price: collected.binancePrice,
      observedAt: collected.binanceObservedAt,
      nowSec,
    }),
    buildSourcePrice({
      source: "kraken",
      price: collected.krakenPrice,
      observedAt: collected.krakenObservedAt,
      nowSec,
    }),
    buildSourcePrice({
      source: "bitstamp",
      price: collected.bitstampPrice,
      observedAt: collected.bitstampObservedAt,
      nowSec,
    }),
    buildSourcePrice({
      source: "coinbase",
      price: collected.coinbasePrice,
      observedAt: collected.coinbaseObservedAt,
      nowSec,
    }),
    buildSourcePrice({
      source: "curve-onchain",
      price: collected.curvePrice,
      observedAt: collected.curveObservedAt,
      nowSec,
    }),
    buildSourcePrice({
      source: "curve-oracle",
      price: asset.id === "crvusd-curve" ? collected.curveOraclePrice : null,
      observedAt: collected.curveOracleObservedAt,
      nowSec,
    }),
    buildSourcePrice({
      source: collected.navQuote?.source ?? "chainlink-nav",
      price: collected.navQuote?.price ?? null,
      observedAt: collected.navQuote?.observedAt ?? null,
      observedAtMode: collected.navQuote?.observedAtMode ?? null,
      nowSec,
      metadata: collected.navQuote?.metadata,
    }),
  ].filter((source): source is SourcePrice => source != null);
  sources.push(...baseSources);

  const redstoneQuote = collected.redstoneQuote;
  if (redstoneQuote && redstoneQuote.venueCount >= 2 && redstoneQuote.venueAgreementPct >= 60) {
    const redstoneSource = buildSourcePrice({
      source: "redstone",
      price: redstoneQuote.price,
      observedAt: redstoneQuote.timestamp,
      nowSec,
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
  const promotedDexProtocolCandidates: SourcePrice[] = [];
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

    const freshness = validatePricingSourceFreshness({
      source: sourceKey,
      observedAt: protocolSource.updatedAt,
      nowSec,
    });
    if (!freshness.accepted) {
      dexCandidateTelemetry.push({
        ...telemetryBase,
        status: "excluded",
        reason: mapFreshnessReasonToDexExclusion(freshness.reason),
      });
      continue;
    }

    const source = buildSourcePrice({
      source: sourceKey,
      price: protocolSource.price,
      observedAt: freshness.observedAt,
      observedAtMode: freshness.observedAtMode,
      nowSec,
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

    promotedDexProtocolCandidates.push(source);
  }

  const hasPromotedDexProtocolSource = promotedDexProtocolCandidates.length > 0;
  const hardTrustTiers = new Set(["hard_market", "hard_oracle", "hard_protocol"]);
  const hasHardCorroborator = sources.some((source) => {
    const tier = getPricingSourceRegistryEntry(source.source)?.trustTier;
    return tier != null && hardTrustTiers.has(tier);
  });
  const hasDexCorroboration =
    promotedDexProtocolCandidates.length > 1 ||
    sources.length === 0 ||
    (hasHardCorroborator &&
      promotedDexProtocolCandidates.some((dexSource) =>
        sources.some((source) => {
          const tier = getPricingSourceRegistryEntry(source.source)?.trustTier;
          return (
            tier != null &&
            hardTrustTiers.has(tier) &&
            pricesAgreeWithinBps(dexSource.price, source.price, divergenceThresholdBps)
          );
        }),
      ));
  const acceptedPromotedDexProtocolSources =
    hasPromotedDexProtocolSource && hasDexCorroboration ? promotedDexProtocolCandidates : [];

  if (acceptedPromotedDexProtocolSources.length > 0) {
    sources.push(...acceptedPromotedDexProtocolSources);
    for (const source of acceptedPromotedDexProtocolSources) {
      const sourceProtocol = source.source.replace(/-dex$/, "");
      const matchingInput = (collected.protocolSources ?? []).find((entry) => entry.protocol === sourceProtocol);
      dexCandidateTelemetry.push(
        buildPromotedDexCandidateTelemetry(asset, source, matchingInput, { status: "accepted" }),
      );
    }
  } else if (hasPromotedDexProtocolSource) {
    for (const source of promotedDexProtocolCandidates) {
      const sourceProtocol = source.source.replace(/-dex$/, "");
      const matchingInput = (collected.protocolSources ?? []).find((entry) => entry.protocol === sourceProtocol);
      dexCandidateTelemetry.push(
        buildPromotedDexCandidateTelemetry(asset, source, matchingInput, {
          status: "excluded",
          reason: "lacked_corroboration",
          divergenceThresholdBps,
        }),
      );
    }
  }

  if (
    collected.dexAggregateQuote &&
    !hasPromotedDexProtocolSource &&
    !hasBinanceDexBridgeOverlap(collected)
  ) {
    const dexAggregateSource = buildSourcePrice({
      source: "dex-promoted",
      price: collected.dexAggregateQuote.dex_price_usd,
      observedAt: collected.dexAggregateQuote.updated_at,
      nowSec,
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
