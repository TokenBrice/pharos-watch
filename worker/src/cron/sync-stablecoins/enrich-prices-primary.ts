import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { sumPegBuckets } from "@shared/lib/supply";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import type { PriceValidationReferences } from "../../lib/price-validation";
import {
  buildPriceValidationContext,
  getReferencePriceForContext,
  isSevereFixedPegDownside,
} from "../../lib/price-validation";
import { USER_AGENT, CIRCUIT_SOURCE, CURVE_ORACLE_MAX_STALENESS_SEC, DEX_FRESHNESS_SEC, POOL_CHALLENGE_MIN_TVL, getDepegThresholdBps } from "../../lib/constants";
import { CG_TICKER_COINS, fetchCgTickerPricesDetailed } from "../../lib/cg-ticker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../../lib/coingecko";
import { shouldAttemptFetch, recordOutcome, recoverBreakerOnNoCandidate } from "../../lib/circuit-breaker";
import { throwIfAborted } from "../../lib/abort";
import { fetchPythPrices } from "../../lib/pyth";
import {
  BITSTAMP_KNOWN_SYMBOLS,
  COINBASE_KNOWN_SYMBOLS,
  KRAKEN_KNOWN_SYMBOLS,
  fetchBinancePricesDetailed,
  fetchBitstampPrices,
  fetchCoinbasePrices,
  fetchKrakenPrices,
} from "../../lib/cex-tickers";
import { isSuccessfulOutcome } from "../../lib/fetcher-result";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { fetchRedstonePrices, REDSTONE_TRACKED_SYMBOL_ALLOWLIST } from "../../lib/redstone";
import { loadDexPriceRows, loadDexPoolChallengers, loadDexPriceSources } from "../../lib/depeg-helpers";
import { isTrustedDexPriceRow } from "../../lib/depeg-trust-policy";
import { fetchCurveOnchainPrices, fetchCurveOracleEma } from "../../lib/curve-onchain";
import { CURVE_POOL_CONFIGS } from "../../lib/curve-pool-configs";
import { CRVUSD_PRICE_AGGREGATOR, CRVUSD_PRICE_SELECTOR } from "../../lib/authoritative-price-sources";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { computePriceConsensus, type SourcePrice } from "../../lib/price-consensus";
import {
  isGtProbeEligibleSingleSource,
  isPoolChallengeEligibleConsensus,
} from "../../lib/pricing-source-policy";
import {
  buildPrimarySourceCandidates,
  type DlListQuote,
  type PrimaryCollectedQuotes,
} from "../../lib/primary-price-collector";
import { aggregateProtocolPrices, computeWeightedMedianPrice } from "../../lib/dex-price-estimators";
import type { PeggedAsset } from "./enrich-prices-shared";

interface CoinGeckoSimplePriceValue {
  usd?: number;
  last_updated_at?: number;
}

export interface PrimaryPriceResult {
  price: number;
  source: string;
  selectedSource?: string;
  priceEstimator?: "selected_source" | "cluster_median";
  confidence: PriceConfidence;
  dlPrice: number | null;
  cgPrice: number | null;
  candidateSources: string[];
  agreeSources: string[];
  disagreeSources?: string[];
  allPrices?: Record<string, number>;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  observedAtBySource?: Record<string, number | null>;
  observedAtModeBySource?: Record<string, PriceObservedAtMode | null>;
  softOnly?: boolean;
}

export interface PriceValidationStats {
  attempted: number;
  high: number;
  singleSource: number;
  cgOnly: number;
  low: number;
}

const INVALID_GECKO_ID_SENTINEL = "wrong";
const PRIMARY_CG_BATCH_SIZE = 250;

function isUsableGeckoId(geckoId: unknown): geckoId is string {
  return typeof geckoId === "string" && geckoId.length > 0 && !geckoId.includes(INVALID_GECKO_ID_SENTINEL);
}

function getSourceDefaultWeight(source: string): number {
  return getPricingSourceRegistryEntry(source)?.defaultWeight ?? 1;
}

async function runPrimaryProviderFetch(
  db: D1Database,
  signal: AbortSignal | undefined,
  source: string,
  label: string,
  fetcher: () => Promise<boolean>,
): Promise<void> {
  try {
    await recordOutcome(db, source, await fetcher());
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn(`[primary-prices] ${label} failed:`, err);
    await recordOutcome(db, source, false);
  }
}

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

async function applyPrimaryPostConsensusHardening(params: {
  db: D1Database;
  candidates: PeggedAsset[];
  results: Map<string, PrimaryPriceResult>;
  stats: PriceValidationStats;
  nowSec: number;
  references?: PriceValidationReferences;
}): Promise<void> {
  applyListAggregatorDowngrade(params.results, params.stats);

  const poolChallengers = await loadDexPoolChallengers(
    params.db,
    POOL_CHALLENGE_MIN_TVL,
    DEX_FRESHNESS_SEC,
    params.nowSec,
  );
  const assetPegTypes = new Map(params.candidates.map((a) => [a.id, a.pegType]));
  const navTokenAssetIds = new Set(
    params.candidates.filter((a) => a.navToken).map((a) => a.id),
  );
  const poolChallengeDowngrades = applyPoolChallenge(
    params.results,
    poolChallengers,
    assetPegTypes,
    params.stats,
    params.references,
    navTokenAssetIds,
  );
  if (poolChallengeDowngrades > 0) {
    console.log(`[primary-prices] Pool challenge hardened ${poolChallengeDowngrades} soft-only result(s)`);
  }

  for (const result of params.results.values()) {
    const challengeSources = result.confidence === "low" ? result.candidateSources : result.agreeSources;
    if (isPoolChallengeEligibleConsensus(challengeSources)) {
      result.softOnly = true;
    }
  }
}

interface PrimaryPricePlan {
  candidates: PeggedAsset[];
  metaById: Map<string, (typeof ACTIVE_STABLECOINS)[number]>;
  nowSec: number;
  dexRows: Awaited<ReturnType<typeof loadDexPriceRows>>;
  dexPriceSources: Awaited<ReturnType<typeof loadDexPriceSources>>;
  geckoIds: string[];
  coingeckoMaxTrustedAgeSec: number;
  pythFeedIds: Map<string, string>;
  coinbaseSymbols: string[];
  krakenSymbols: string[];
  shouldFetchBitstamp: boolean;
  redstoneSymbols: string[];
  sourceAllowed: {
    cg: boolean;
    cgTicker: boolean;
    pyth: boolean;
    binance: boolean;
    kraken: boolean;
    bitstamp: boolean;
    coinbase: boolean;
    redstone: boolean;
    curve: boolean;
    curveOracle: boolean;
  };
}

interface PrimaryConsensusQuoteMaps {
  cgPrices: Map<string, number>;
  cgObservedAtByGeckoId: Map<string, number>;
  cgObservedAtModeByGeckoId: Map<string, PriceObservedAtMode>;
  cgObservedAt: number | null;
  cgTickerPrices: Map<string, number>;
  cgTickerObservedAt: number | null;
  pythPrices: Map<string, { price: number; confidenceBps: number; publishTime: number }>;
  binancePrices: Map<string, number>;
  binanceObservedAt: number | null;
  krakenPrices: Map<string, number>;
  krakenObservedAt: number | null;
  bitstampPrices: Map<string, number>;
  bitstampObservedAt: number | null;
  coinbasePrices: Map<string, number>;
  coinbaseObservedAt: number | null;
  redstonePrices: Map<string, { price: number; venueCount: number; venueAgreementPct: number; timestamp: number }>;
  curvePrices: Map<string, number>;
  curveObservedAt: number | null;
  curveOraclePrice: number | null;
  curveOracleObservedAt: number | null;
}

async function buildPrimaryPricePlan(
  assets: PeggedAsset[],
  db: D1Database,
  dlListPrices?: Map<string, number | DlListQuote>,
): Promise<PrimaryPricePlan> {
  const metaById = new Map(ACTIVE_STABLECOINS.map((m) => [m.id, m]));
  const nowSec = Math.floor(Date.now() / 1000);
  const dexRows = await loadDexPriceRows(db);
  const dexPriceSources = await loadDexPriceSources(db);

  const coinbaseKnownSet = new Set(COINBASE_KNOWN_SYMBOLS);
  const krakenKnownSet = new Set(KRAKEN_KNOWN_SYMBOLS);
  const bitstampKnownSet = new Set(BITSTAMP_KNOWN_SYMBOLS);
  const redstoneSymbolSet = new Set<string>(REDSTONE_TRACKED_SYMBOL_ALLOWLIST);
  const curveEligibleIds = new Set(CURVE_POOL_CONFIGS.map((config) => config.stablecoinId));
  curveEligibleIds.add("crvusd-curve");

  const candidates = assets.filter((asset) => {
    const meta = metaById.get(asset.id);
    const symbolUpper = asset.symbol.toUpperCase();
    const hasValidGeckoId = isUsableGeckoId(asset.geckoId);
    return hasValidGeckoId ||
      (dlListPrices?.has(asset.id) ?? false) ||
      !!meta?.pythFeedId ||
      coinbaseKnownSet.has(symbolUpper) ||
      krakenKnownSet.has(symbolUpper) ||
      bitstampKnownSet.has(symbolUpper) ||
      redstoneSymbolSet.has(asset.symbol) ||
      curveEligibleIds.has(asset.id) ||
      dexRows.has(asset.id) ||
      dexPriceSources.has(asset.id);
  });

  if (candidates.length === 0) {
    return {
      candidates,
      metaById,
      nowSec,
      dexRows,
      dexPriceSources,
      geckoIds: [],
      coingeckoMaxTrustedAgeSec: getPricingSourceRegistryEntry("coingecko")?.maxTrustedAgeSec ?? 15 * 60,
      pythFeedIds: new Map(),
      coinbaseSymbols: [],
      krakenSymbols: [],
      shouldFetchBitstamp: false,
      redstoneSymbols: [],
      sourceAllowed: {
        cg: false,
        cgTicker: false,
        pyth: false,
        binance: false,
        kraken: false,
        bitstamp: false,
        coinbase: false,
        redstone: false,
        curve: false,
        curveOracle: false,
      },
    };
  }

  const [
    cgAllowed,
    cgTickerAllowed,
    pythAllowed,
    binanceAllowed,
    krakenAllowed,
    bitstampAllowed,
    coinbaseAllowed,
    redstoneAllowed,
    curveAllowed,
    curveOracleAllowed,
  ] = await Promise.all([
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_TICKER),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.PYTH_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.KRAKEN_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.BITSTAMP_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.COINBASE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.REDSTONE_PRICES),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ORACLE),
  ]);

  if (!cgAllowed && !pythAllowed && !binanceAllowed && !krakenAllowed && !bitstampAllowed && !coinbaseAllowed && !redstoneAllowed && !curveAllowed && !curveOracleAllowed) {
    console.warn("[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only");
  }

  const geckoIds = [...new Set(
    candidates
      .map((asset) => asset.geckoId)
      .filter(isUsableGeckoId),
  )];

  const pythFeedIds = new Map<string, string>();
  for (const asset of candidates) {
    const meta = metaById.get(asset.id);
    if (meta?.pythFeedId) {
      pythFeedIds.set(asset.id, meta.pythFeedId);
    }
  }

  const candidateSymbolsUpper = [...new Set(candidates.map((a) => a.symbol.toUpperCase()))];
  const coinbaseSymbols = candidateSymbolsUpper.filter((s) => coinbaseKnownSet.has(s));
  const krakenSymbols = candidateSymbolsUpper.filter((s) => krakenKnownSet.has(s));
  const shouldFetchBitstamp = candidateSymbolsUpper.some((symbol) => bitstampKnownSet.has(symbol));
  const redstoneSymbols = [...new Set(candidates.map((a) => a.symbol).filter((symbol) => redstoneSymbolSet.has(symbol)))];
  const coingeckoMaxTrustedAgeSec = getPricingSourceRegistryEntry("coingecko")?.maxTrustedAgeSec ?? 15 * 60;

  return {
    candidates,
    metaById,
    nowSec,
    dexRows,
    dexPriceSources,
    geckoIds,
    coingeckoMaxTrustedAgeSec,
    pythFeedIds,
    coinbaseSymbols,
    krakenSymbols,
    shouldFetchBitstamp,
    redstoneSymbols,
    sourceAllowed: {
      cg: cgAllowed,
      cgTicker: cgTickerAllowed,
      pyth: pythAllowed,
      binance: binanceAllowed,
      kraken: krakenAllowed,
      bitstamp: bitstampAllowed,
      coinbase: coinbaseAllowed,
      redstone: redstoneAllowed,
      curve: curveAllowed,
      curveOracle: curveOracleAllowed,
    },
  };
}

function buildPrimaryConsensusResults(params: {
  candidates: PeggedAsset[];
  references?: PriceValidationReferences;
  quoteMaps: PrimaryConsensusQuoteMaps;
  dexRows: Awaited<ReturnType<typeof loadDexPriceRows>>;
  dexPriceSources: Awaited<ReturnType<typeof loadDexPriceSources>>;
  nowSec: number;
  resolveDlListQuote: (assetId: string) => DlListQuote | undefined;
  results: Map<string, PrimaryPriceResult>;
  stats: PriceValidationStats;
}): void {
  const DIVERGENCE_THRESHOLD_BPS = 50;

  for (const asset of params.candidates) {
    const gId = isUsableGeckoId(asset.geckoId) ? asset.geckoId : null;
    const cg = gId ? (params.quoteMaps.cgPrices.get(gId) ?? null) : null;
    const cgObservedAtForAsset = gId && cg != null
      ? (params.quoteMaps.cgObservedAtByGeckoId.get(gId) ?? params.quoteMaps.cgObservedAt)
      : null;
    const cgObservedAtModeForAsset = gId && cg != null
      ? (params.quoteMaps.cgObservedAtModeByGeckoId.get(gId) ?? (params.quoteMaps.cgObservedAt != null ? "local_fetch" : null))
      : null;
    const collectedQuotes: PrimaryCollectedQuotes = {
      cgPrice: cg,
      cgObservedAt: cgObservedAtForAsset,
      cgObservedAtMode: cgObservedAtModeForAsset,
      cgTickerPrice: params.quoteMaps.cgTickerPrices.get(asset.id) ?? null,
      cgTickerObservedAt: params.quoteMaps.cgTickerObservedAt,
      dlListQuote: params.resolveDlListQuote(asset.id),
      pythQuote: params.quoteMaps.pythPrices.get(asset.id),
      binancePrice: params.quoteMaps.binancePrices.get(asset.symbol.toUpperCase()) ?? null,
      binanceObservedAt: params.quoteMaps.binanceObservedAt,
      krakenPrice: params.quoteMaps.krakenPrices.get(asset.symbol.toUpperCase()) ?? null,
      krakenObservedAt: params.quoteMaps.krakenObservedAt,
      bitstampPrice: params.quoteMaps.bitstampPrices.get(asset.symbol.toUpperCase()) ?? null,
      bitstampObservedAt: params.quoteMaps.bitstampObservedAt,
      coinbasePrice: params.quoteMaps.coinbasePrices.get(asset.symbol.toUpperCase()) ?? null,
      coinbaseObservedAt: params.quoteMaps.coinbaseObservedAt,
      redstoneQuote: params.quoteMaps.redstonePrices.get(asset.symbol),
      curvePrice: params.quoteMaps.curvePrices.get(asset.id) ?? null,
      curveObservedAt: params.quoteMaps.curveObservedAt,
      curveOraclePrice: params.quoteMaps.curveOraclePrice,
      curveOracleObservedAt: params.quoteMaps.curveOracleObservedAt,
      protocolSources: params.dexPriceSources.get(asset.id),
      dexAggregateQuote: (() => {
        const dexRow = params.dexRows.get(asset.id);
        return dexRow && isTrustedDexPriceRow(dexRow, params.nowSec, "depeg") ? dexRow : undefined;
      })(),
    };

    const { sources, hasPromotedDexProtocolSource } = buildPrimarySourceCandidates(asset, collectedQuotes, {
      divergenceThresholdBps: DIVERGENCE_THRESHOLD_BPS,
    });

    if (hasPromotedDexProtocolSource && !sources.some((source) => source.source.endsWith("-dex"))) {
      console.log(
        `[primary-prices] ${asset.symbol}: suppressed promoted DEX source(s) that lacked corroboration`,
      );
    }

    params.stats.attempted++;

    const context = buildPriceValidationContext({
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
      dlPrice: params.resolveDlListQuote(asset.id)?.price ?? null,
      cgPrice: cg ?? null,
      candidateSources: sources.map((s) => s.source),
      agreeSources: consensus.agreeSources,
      disagreeSources: consensus.disagreeSources,
      allPrices: consensus.allPrices,
      observedAt: consensus.observedAt,
      observedAtMode: consensus.observedAtMode,
      observedAtBySource: consensus.observedAtBySource,
      observedAtModeBySource: consensus.observedAtModeBySource,
    });

    if (consensus.confidence === "high") params.stats.high++;
    else if (consensus.confidence === "single-source") params.stats.singleSource++;
    else params.stats.low++;

    if (consensus.confidence === "single-source" && consensus.source === "coingecko") {
      params.stats.cgOnly++;
    }

    if (consensus.disagreeSources.length > 0) {
      const highWeightDisagrees = sources
        .filter((s) => s.weight >= 2 && consensus.disagreeSources.includes(s.source))
        .map((s) => `${s.source}($${s.price.toFixed(4)})`);
      if (highWeightDisagrees.length > 0) {
        console.log(
          `[primary-prices] ${asset.symbol}: high-weight disagree: ${highWeightDisagrees.join(", ")} `
          + `vs consensus $${consensus.price.toFixed(4)}`,
        );
      }
    }
  }
}

/**
 * Fetch prices from CG, Pyth, CEX tickers, Curve on-chain, and DEX sources in parallel,
 * cross-validate within 50bps, and return a confidence-tagged result per asset.
 * Optionally accepts DL stablecoins list prices as an independent voice.
 */
export async function fetchPrimaryPrices(
  assets: PeggedAsset[],
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  dlListPrices?: Map<string, number | DlListQuote>,
): Promise<{
  results: Map<string, PrimaryPriceResult>;
  stats: PriceValidationStats;
  cgPrices: Map<string, number>;
  providerDiagnostics?: PricingProviderAttemptDiagnostic[];
}> {
  throwIfAborted(signal);
  const resolveDlListQuote = (assetId: string): DlListQuote | undefined => {
    const entry = dlListPrices?.get(assetId);
    if (entry == null) return undefined;
    if (typeof entry === "number") {
      return {
        price: entry,
        observedAt: null,
        observedAtMode: "unknown",
      };
    }
    return entry;
  };
  const results = new Map<string, PrimaryPriceResult>();
  const stats: PriceValidationStats = { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 };
  const plan = await buildPrimaryPricePlan(assets, db, dlListPrices);
  const {
    candidates,
    dexRows,
    dexPriceSources,
    geckoIds,
    coingeckoMaxTrustedAgeSec,
    pythFeedIds,
    coinbaseSymbols,
    krakenSymbols,
    shouldFetchBitstamp,
    redstoneSymbols,
    nowSec,
    sourceAllowed,
  } = plan;
  if (candidates.length === 0) return { results, stats, cgPrices: new Map() };

  const cgPrices = new Map<string, number>();
  const cgObservedAtByGeckoId = new Map<string, number>();
  const cgObservedAtModeByGeckoId = new Map<string, PriceObservedAtMode>();
  const pythPrices = new Map<string, { price: number; confidenceBps: number; publishTime: number }>();
  const binancePrices = new Map<string, number>();
  const krakenPrices = new Map<string, number>();
  const bitstampPrices = new Map<string, number>();
  const coinbasePrices = new Map<string, number>();
  const redstonePrices = new Map<string, { price: number; venueCount: number; venueAgreementPct: number; timestamp: number }>();
  const curvePrices = new Map<string, number>();
  let curveOraclePrice: number | null = null;
  const cgTickerPrices = new Map<string, number>();
  let cgTickerObservedAt: number | null = null;
  let cgObservedAt: number | null = null;
  let binanceObservedAt: number | null = null;
  let krakenObservedAt: number | null = null;
  let bitstampObservedAt: number | null = null;
  let coinbaseObservedAt: number | null = null;
  let curveObservedAt: number | null = null;
  let curveOracleObservedAt: number | null = null;
  let staleCgPriceRows = 0;
  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];

  const fetches: Promise<void>[] = [];

  if (sourceAllowed.cg) {
    fetches.push(
      (async () => {
        try {
          let hadBatchFailure = false;
          for (let i = 0; i < geckoIds.length; i += PRIMARY_CG_BATCH_SIZE) {
            throwIfAborted(signal);
            const batch = geckoIds.slice(i, i + PRIMARY_CG_BATCH_SIZE);
            const ids = batch.join(",");
            const res = await fetchWithRetry(
              cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`, coingeckoApiKey ?? null),
              {
                headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
                signal,
              },
            );
            if (res?.ok) {
              const data = (await res.json()) as Record<string, CoinGeckoSimplePriceValue>;
              for (const [gId, val] of Object.entries(data)) {
                if (val?.usd != null && val.usd > 0) {
                  const upstreamObservedAt =
                    typeof val.last_updated_at === "number" &&
                    Number.isFinite(val.last_updated_at) &&
                    val.last_updated_at > 0
                      ? val.last_updated_at
                      : null;
                  if (
                    upstreamObservedAt != null &&
                    nowSec - upstreamObservedAt > coingeckoMaxTrustedAgeSec
                  ) {
                    staleCgPriceRows++;
                    continue;
                  }
                  cgPrices.set(gId, val.usd);
                  if (upstreamObservedAt != null) {
                    cgObservedAtByGeckoId.set(gId, upstreamObservedAt);
                    cgObservedAtModeByGeckoId.set(gId, "upstream");
                  }
                }
              }
              if (Object.keys(data).length > 0) {
                cgObservedAt = Math.floor(Date.now() / 1000);
              }
            } else {
              hadBatchFailure = true;
              console.warn(`[primary-prices] CG price API returned ${res?.status ?? "no response"}`);
            }
          }
          await recordOutcome(db, CIRCUIT_SOURCE.CG_PRICES, !hadBatchFailure);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] CG price API failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.CG_PRICES, false);
        }
      })(),
    );
  }

  if (sourceAllowed.cgTicker && CG_TICKER_COINS.length > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.CG_TICKER,
        "CG ticker API",
        async () => {
          const { prices, successfulResponses } = await fetchCgTickerPricesDetailed(
            CG_TICKER_COINS,
            coingeckoApiKey ?? null,
            signal,
          );
          for (const [coinId, price] of prices) cgTickerPrices.set(coinId, price);
          if (prices.size > 0) cgTickerObservedAt = Math.floor(Date.now() / 1000);
          return successfulResponses > 0;
        },
      ),
    );
  }

  if (sourceAllowed.pyth && pythFeedIds.size > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.PYTH_PRICES,
        "Pyth Hermes API",
        async () => {
          const outcome = await fetchPythPrices(pythFeedIds, signal);
          for (const [coinId, result] of outcome.value) {
            pythPrices.set(coinId, {
              price: result.price,
              confidenceBps: result.confidenceBps,
              publishTime: result.publishTime,
            });
          }
          return isSuccessfulOutcome(outcome);
        },
      ),
    );
  }

  if (sourceAllowed.binance || sourceAllowed.kraken || sourceAllowed.bitstamp || sourceAllowed.coinbase) {
    fetches.push(
      (async () => {
        if (sourceAllowed.binance) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.BINANCE_PRICES, "Binance ticker", async () => {
            const outcome = await fetchBinancePricesDetailed(signal);
            const { prices, diagnostics } = outcome.value;
            providerDiagnostics.push(...diagnostics);
            for (const [symbol, price] of prices) binancePrices.set(symbol, price);
            if (prices.size > 0) binanceObservedAt = Math.floor(Date.now() / 1000);
            return isSuccessfulOutcome(outcome);
          });
        }

        if (sourceAllowed.kraken && krakenSymbols.length > 0) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.KRAKEN_PRICES, "Kraken ticker", async () => {
            const outcome = await fetchKrakenPrices(krakenSymbols, signal);
            for (const [symbol, price] of outcome.value) krakenPrices.set(symbol, price);
            if (outcome.value.size > 0) krakenObservedAt = Math.floor(Date.now() / 1000);
            return isSuccessfulOutcome(outcome);
          });
        }

        if (sourceAllowed.bitstamp && shouldFetchBitstamp) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.BITSTAMP_PRICES, "Bitstamp ticker", async () => {
            const outcome = await fetchBitstampPrices(signal);
            for (const [symbol, price] of outcome.value) bitstampPrices.set(symbol, price);
            if (outcome.value.size > 0) bitstampObservedAt = Math.floor(Date.now() / 1000);
            return isSuccessfulOutcome(outcome);
          });
        }

        if (sourceAllowed.coinbase && coinbaseSymbols.length > 0) {
          await runPrimaryProviderFetch(db, signal, CIRCUIT_SOURCE.COINBASE_PRICES, "Coinbase ticker", async () => {
            const outcome = await fetchCoinbasePrices(coinbaseSymbols, signal);
            for (const [symbol, price] of outcome.value) coinbasePrices.set(symbol, price);
            if (outcome.value.size > 0) coinbaseObservedAt = Math.floor(Date.now() / 1000);
            return isSuccessfulOutcome(outcome);
          });
        }
      })(),
    );
  }

  // Breaker-recovery path: when a provider has zero tracked candidates
  // there is nothing to probe, so mirror the Jupiter pass and coax an
  // open/half-open breaker toward closed instead of leaving it stuck.
  if (krakenSymbols.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.KRAKEN_PRICES));
  }
  if (!shouldFetchBitstamp) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.BITSTAMP_PRICES));
  }
  if (coinbaseSymbols.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.COINBASE_PRICES));
  }

  if (sourceAllowed.redstone && redstoneSymbols.length > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.REDSTONE_PRICES,
        "RedStone API",
        async () => {
          const outcome = await fetchRedstonePrices(redstoneSymbols, signal);
          for (const [symbol, result] of outcome.value) {
            redstonePrices.set(symbol, {
              price: result.price,
              venueCount: result.venueCount,
              venueAgreementPct: result.venueAgreementPct,
              timestamp: result.timestamp,
            });
          }
          return isSuccessfulOutcome(outcome);
        },
      ),
    );
  } else if (redstoneSymbols.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.REDSTONE_PRICES));
  }

  if (sourceAllowed.curve && CURVE_POOL_CONFIGS.length > 0) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.CURVE_ONCHAIN,
        "Curve on-chain",
        async () => {
          const outcome = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, signal, chainRpcs);
          for (const [id, price] of outcome.value) curvePrices.set(id, price);
          if (outcome.value.size > 0) curveObservedAt = Math.floor(Date.now() / 1000);
          return isSuccessfulOutcome(outcome);
        },
      ),
    );
  } else if (CURVE_POOL_CONFIGS.length === 0) {
    fetches.push(recoverBreakerOnNoCandidate(db, CIRCUIT_SOURCE.CURVE_ONCHAIN));
  }

  if (sourceAllowed.curveOracle) {
    fetches.push(
      runPrimaryProviderFetch(
        db,
        signal,
        CIRCUIT_SOURCE.CURVE_ORACLE,
        "crvUSD oracle",
        async () => {
          const quote = await fetchCurveOracleEma(
            "ethereum",
            CRVUSD_PRICE_AGGREGATOR,
            CRVUSD_PRICE_SELECTOR,
            chainRpcs ?? new Map(),
            signal,
          );
          if (!quote) return false;
          const now = Math.floor(Date.now() / 1000);
          if (now - quote.blockTimestamp > CURVE_ORACLE_MAX_STALENESS_SEC) return false;
          curveOraclePrice = quote.price;
          curveOracleObservedAt = quote.blockTimestamp;
          return true;
        },
      ),
    );
  }

  await Promise.all(fetches);
  throwIfAborted(signal);
  if (staleCgPriceRows > 0) {
    console.warn(
      `[primary-prices] Dropped ${staleCgPriceRows} stale CoinGecko simple-price row(s) older than ${coingeckoMaxTrustedAgeSec}s`,
    );
  }

  buildPrimaryConsensusResults({
    candidates,
    references,
    quoteMaps: {
      cgPrices,
      cgObservedAtByGeckoId,
      cgObservedAtModeByGeckoId,
      cgObservedAt,
      cgTickerPrices,
      cgTickerObservedAt,
      pythPrices,
      binancePrices,
      binanceObservedAt,
      krakenPrices,
      krakenObservedAt,
      bitstampPrices,
      bitstampObservedAt,
      coinbasePrices,
      coinbaseObservedAt,
      redstonePrices,
      curvePrices,
      curveObservedAt,
      curveOraclePrice,
      curveOracleObservedAt,
    },
    dexRows,
    dexPriceSources,
    nowSec,
    resolveDlListQuote,
    results,
    stats,
  });

  await applyPrimaryPostConsensusHardening({ db, candidates, results, stats, nowSec, references });

  if (dlListPrices) {
    const withDl = candidates.filter((a) => dlListPrices.has(a.id)).length;
    const withoutDl = candidates.length - withDl;
    if (withoutDl > 0) {
      console.log(`[primary-prices] DL list coverage: ${withDl}/${candidates.length} (${withoutDl} missing)`);
    }
  }

  console.log(
    `[primary-prices] ${stats.attempted} assets: ${stats.high} high, ${stats.singleSource} single-source, ${stats.low} low confidence`,
  );

  return { results, stats, cgPrices, providerDiagnostics };
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
): boolean {
  const context = buildPriceValidationContext({ stablecoinId: assetId, pegType });
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

/**
 * For assets that are single-source eligible soft-source results after primary consensus,
 * probe GeckoTerminal for an independent pool-level price and re-run
 * consensus with the additional source.
 */
export async function runGtProbePass(
  assets: PeggedAsset[],
  primaryResults: Map<string, PrimaryPriceResult>,
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
): Promise<{ updatedCount: number; stats: import("../../lib/geckoterminal-price-probe").GtProbeStats }> {
  const { createEmptyGtProbeStats, probeGeckoTerminalPrices } = await import("../../lib/geckoterminal-price-probe");

  const singleSourceAssets: Array<{ id: string; price: number; priorityUsd: number }> = [];
  for (const asset of assets) {
    const primary = primaryResults.get(asset.id);
    if (!primary) continue;
    const hasHardAuthoritativeSource = primary.candidateSources.some((source) => (
      getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false
    ));
    if (
      !hasHardAuthoritativeSource &&
      (primary.confidence === "single-source" || primary.confidence === "low") &&
      primary.candidateSources.some((source) => isGtProbeEligibleSingleSource(source))
    ) {
      singleSourceAssets.push({
        id: asset.id,
        price: primary.price,
        priorityUsd: sumPegBuckets(asset.circulating),
      });
    }
  }

  if (singleSourceAssets.length === 0) {
    return {
      updatedCount: 0,
      stats: createEmptyGtProbeStats(),
    };
  }

  const { prices: gtPrices, stats } = await probeGeckoTerminalPrices(singleSourceAssets, db, signal, coingeckoApiKey);

  let updatedCount = 0;
  for (const asset of assets) {
    const gtSource = gtPrices.get(asset.id);
    if (!gtSource) continue;

    const primary = primaryResults.get(asset.id);
    if (!primary) continue;

    const sources: SourcePrice[] = [];
    for (const source of primary.candidateSources) {
      const price = primary.allPrices?.[source];
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
      sources.push({
        source,
        price,
        weight: getSourceDefaultWeight(source),
        observedAt: primary.observedAtBySource?.[source] ?? null,
        observedAtMode: primary.observedAtModeBySource?.[source] ?? null,
      });
    }
    sources.push(gtSource);

    const context = buildPriceValidationContext({
      stablecoinId: String(asset.id),
      pegType: asset.pegType,
      navToken: asset.navToken,
      commodityOunces: asset.commodityOunces,
    });
    const pegRef = context.navToken ? null : getReferencePriceForContext(context, references);
    const consensus = computePriceConsensus(sources, pegRef, 50, {
      mode: context.navToken ? "nav" : "fixed",
    });

    if (!consensus) continue;

    primary.price = consensus.price;
    primary.source = consensus.source;
    primary.selectedSource = consensus.selectedSource;
    primary.priceEstimator = consensus.priceEstimator;
    primary.confidence = consensus.confidence;
    primary.candidateSources = sources.map((s) => s.source);
    primary.agreeSources = consensus.agreeSources;
    primary.disagreeSources = consensus.disagreeSources;
    primary.allPrices = consensus.allPrices;
    primary.observedAt = consensus.observedAt;
    primary.observedAtMode = consensus.observedAtMode;
    primary.observedAtBySource = consensus.observedAtBySource;
    primary.observedAtModeBySource = consensus.observedAtModeBySource;
    updatedCount++;
  }

  return { updatedCount, stats };
}
