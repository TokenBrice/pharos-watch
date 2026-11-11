import type { PriceObservedAtMode, PriceSourceConfidenceProfile } from "@shared/types/price";
import type { HiveNativePriceQuote } from "@shared/types/hive-market-price";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { isHardPricingTrustTier } from "@shared/lib/pricing-source-policy";
import { pricesAgreeWithinBps } from "./price-divergence";
import type { SourcePrice } from "./price-consensus";
import { validatePricingSourceFreshness, type PricingSourceFreshnessRejectReason } from "./pricing-source-freshness";

interface PrimaryPriceAssetLike {
  id: string;
  symbol: string;
  geckoId?: string | null;
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
  aggregateObservedAt?: number | null;
  source_pool_count: number;
  source_total_tvl: number;
}

export interface NavTelemetryQuote {
  source: "chainlink-nav" | "superstate-liquidity" | "jpmorgan-nav";
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
  | "outside_co_leg_budget"
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
  /** For `outside_co_leg_budget`: the budget the lane's age was judged against. */
  coLegBudgetSec?: number;
  ageSec?: number;
}

function buildPromotedDexCandidateTelemetry(
  asset: PrimaryPriceAssetLike,
  source: SourcePrice,
  matchingInput: DexProtocolSourceQuote | undefined,
  outcome: Pick<PrimaryDexCandidateTelemetry, "status"> &
    Partial<Pick<PrimaryDexCandidateTelemetry, "reason" | "divergenceThresholdBps" | "coLegBudgetSec" | "ageSec">>,
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
  curvePrice: number | null;
  curveObservedAt: number | null;
  curveOraclePrice: number | null;
  curveOracleObservedAt: number | null;
  navQuote?: NavTelemetryQuote;
  hiveNativeQuote?: HiveNativePriceQuote;
  protocolSources?: DexProtocolSourceQuote[];
  dexAggregateQuote?: DexAggregateQuote;
}

export interface PrimarySourceBuildResult {
  sources: SourcePrice[];
  hasPromotedDexProtocolSource: boolean;
  /**
   * Corroborated lanes read this run but kept out of the cluster only by the
   * co-leg budget. They remain available (non-voting) consensus candidates.
   */
  coLegHeldDexSources: string[];
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

/**
 * Later same-run readers (authoritative parent checks) validate the composite
 * clock after consensus; this margin keeps a co-leg admitted at `nowSec` fresh
 * through the rest of the run.
 */
const DEX_CO_LEG_RUN_LATENCY_MARGIN_SEC = 180;

/**
 * Consensus stamps a cluster with its oldest agreeing leg's clock. DEX legs
 * (the `dex-promoted` aggregate and the per-protocol lanes) come from the
 * hourly DEX writer and stay eligible for 75 and 35 minutes, so as extra legs
 * they would pin fresh CEX/oracle agreement to the previous DEX run and age
 * the composite past the 30-minute primary budget. That stale clock made the
 * next DEX run reject its own quote legs (USDC, USDT, ...), drop their DEX
 * rows, and flip back an hour later. A 30-35 minute lane likewise aged
 * Curve-backed composites past that budget, so pmUSD's open depeg recorded
 * blind coverage about once an hour.
 * Composite freshness also holds every part to its own registry window
 * against that one clock, so a 15-30 minute DEX leg beside 15-minute
 * CoinGecko/DefiLlama legs failed every authoritative child's parent check
 * once an hour. Beside other legs a DEX leg therefore joins only while it fits
 * the primary budget and the strictest co-leg window; as the sole kind of leg
 * it keeps its own freshness window.
 */
function getDexCoLegBudgetSec(coLegSources: readonly { source: string }[]): number {
  let maxAgeSec = DEPEG_PRIMARY_PRICE_MAX_AGE_SEC;
  for (const { source } of coLegSources) {
    const sourceMaxAgeSec = getPricingSourceRegistryEntry(source)?.maxTrustedAgeSec;
    if (sourceMaxAgeSec != null && sourceMaxAgeSec > 0) {
      maxAgeSec = Math.min(maxAgeSec, sourceMaxAgeSec - DEX_CO_LEG_RUN_LATENCY_MARGIN_SEC);
    }
  }
  return maxAgeSec;
}

export function isDexLegWithinCoLegBudget(
  observedAt: number,
  coLegSources: readonly { source: string }[],
  nowSec: number,
): boolean {
  return nowSec - observedAt <= getDexCoLegBudgetSec(coLegSources);
}

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
  options?: {
    divergenceThresholdBps?: number;
    nowSec?: number;
    /**
     * Consensus authority for whether the fresh legs agree on their own. Without
     * it no lane older than the co-leg budget is admitted.
     */
    freshLegsAgree?: (legs: readonly SourcePrice[]) => boolean;
    /**
     * Consensus authority for an older lane proposed by the degraded rejoin.
     * Receives the fresh legs plus that lane; true only when the lane lands in a
     * hard leg's agreement group, not a larger soft or list cluster.
     */
    fallbackLaneLandsInHardGroup?: (legs: readonly SourcePrice[], lane: SourcePrice) => boolean;
  },
): PrimarySourceBuildResult {
  const divergenceThresholdBps = options?.divergenceThresholdBps ?? DIVERGENCE_THRESHOLD_BPS;
  const nowSec = options?.nowSec;
  const sources: SourcePrice[] = [];

  const baseSources = [
    buildSourcePrice({
      source: "hive-native-cg",
      price: asset.id === "hbd-hive" ? collected.hiveNativeQuote?.price : null,
      observedAt: collected.hiveNativeQuote?.observedAt,
      observedAtMode: collected.hiveNativeQuote?.observedAtMode,
      nowSec,
    }),
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
  const agreesWithHardSource = (dexSource: SourcePrice): boolean =>
    baseSources.some(
      (source) =>
        isHardPricingTrustTier(getPricingSourceRegistryEntry(source.source)?.trustTier) &&
        pricesAgreeWithinBps(dexSource.price, source.price, divergenceThresholdBps),
    );
  const agreesWithIndependentDexSource = (dexSource: SourcePrice, pool: readonly SourcePrice[]): boolean => {
    const dexSourceFamily = getPricingSourceRegistryEntry(dexSource.source)?.depegSourceFamily;
    return pool.some((otherDexSource) =>
      otherDexSource !== dexSource &&
      getPricingSourceRegistryEntry(otherDexSource.source)?.depegSourceFamily !== dexSourceFamily &&
      pricesAgreeWithinBps(dexSource.price, otherDexSource.price, divergenceThresholdBps));
  };

  // Beside base legs a lane must fit the co-leg budget, and only lanes that fit
  // it can corroborate one another; otherwise one lane would date the composite.
  const coLegNowSec = nowSec ?? Math.floor(Date.now() / 1000);
  const coLegBudgetSec = baseSources.length > 0 ? getDexCoLegBudgetSec(baseSources) : null;
  const laneAgeSec = (dexSource: SourcePrice): number | null =>
    typeof dexSource.observedAt === "number" ? coLegNowSec - dexSource.observedAt : null;
  const fitsCoLegBudget = (dexSource: SourcePrice): boolean => {
    if (coLegBudgetSec == null) return true;
    const ageSec = laneAgeSec(dexSource);
    return ageSec != null && ageSec <= coLegBudgetSec;
  };
  const coLegLanes = promotedDexProtocolCandidates.filter(fitsCoLegBudget);
  const admittedPromotedDexProtocolSources = coLegLanes.filter((dexSource) =>
    agreesWithHardSource(dexSource) || agreesWithIndependentDexSource(dexSource, coLegLanes));
  // Degraded fallback: when the fresh legs cannot agree on their own (one is
  // missing or diverging), a lane inside the primary budget that agrees with a
  // fresh hard leg may still join. Consensus then dates the result by the
  // lane's own older clock, never by the fresh legs' clock.
  const fallbackLanes = coLegBudgetSec == null ? [] : promotedDexProtocolCandidates.filter((dexSource) => {
    const ageSec = laneAgeSec(dexSource);
    return !fitsCoLegBudget(dexSource) && ageSec != null && ageSec <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC &&
      agreesWithHardSource(dexSource);
  });
  if (
    fallbackLanes.length > 0 &&
    options?.freshLegsAgree?.([...baseSources, ...admittedPromotedDexProtocolSources]) === false
  ) {
    for (const lane of fallbackLanes) {
      const legs = [...baseSources, ...admittedPromotedDexProtocolSources, lane];
      if (options.fallbackLaneLandsInHardGroup == null || options.fallbackLaneLandsInHardGroup(legs, lane)) {
        admittedPromotedDexProtocolSources.push(lane);
      }
    }
  }

  if (admittedPromotedDexProtocolSources.length > 0) {
    sources.push(...admittedPromotedDexProtocolSources);
  }
  const coLegHeldDexSources = new Set<string>();
  for (const source of promotedDexProtocolCandidates) {
    const sourceProtocol = source.source.replace(/-dex$/, "");
    const matchingInput = (collected.protocolSources ?? []).find((entry) => entry.protocol === sourceProtocol);
    let outcome: Parameters<typeof buildPromotedDexCandidateTelemetry>[3];
    if (admittedPromotedDexProtocolSources.includes(source)) {
      outcome = { status: "accepted" };
    } else if (!fitsCoLegBudget(source)) {
      outcome = {
        status: "excluded",
        reason: "outside_co_leg_budget",
        coLegBudgetSec: coLegBudgetSec ?? undefined,
        ageSec: laneAgeSec(source) ?? undefined,
      };
      if (agreesWithHardSource(source) || agreesWithIndependentDexSource(source, promotedDexProtocolCandidates)) {
        coLegHeldDexSources.add(source.source);
      }
    } else {
      outcome = { status: "excluded", reason: "lacked_corroboration", divergenceThresholdBps };
    }
    dexCandidateTelemetry.push(buildPromotedDexCandidateTelemetry(asset, source, matchingInput, outcome));
  }

  if (
    collected.dexAggregateQuote &&
    collected.dexAggregateQuote.aggregateObservedAt != null &&
    collected.dexAggregateQuote.aggregateObservedAt <= coLegNowSec &&
    !hasPromotedDexProtocolSource &&
    !hasBinanceDexBridgeOverlap(collected)
  ) {
    const dexAggregateSource = buildSourcePrice({
      source: "dex-promoted",
      price: collected.dexAggregateQuote.dex_price_usd,
      observedAt: collected.dexAggregateQuote.aggregateObservedAt,
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
    coLegHeldDexSources: [...coLegHeldDexSources],
    dexCandidateTelemetry,
    priceSourceConfidenceProfile: buildPriceSourceConfidenceProfile(sources, options?.nowSec),
  };
}
