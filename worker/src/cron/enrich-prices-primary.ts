import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import type { PriceValidationReferences } from "../lib/price-validation";
import {
  buildPriceValidationContext,
  getReferencePriceForContext,
} from "../lib/price-validation";
import { USER_AGENT, CIRCUIT_SOURCE, DEX_FRESHNESS_SEC, POOL_CHALLENGE_MIN_TVL, getDepegThresholdBps } from "../lib/constants";
import { CG_TICKER_COINS, fetchCgTickerPrices } from "../lib/cg-ticker";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { throwIfAborted } from "../lib/abort";
import { fetchPythPrices } from "../lib/pyth";
import {
  BITSTAMP_KNOWN_SYMBOLS,
  COINBASE_KNOWN_SYMBOLS,
  KRAKEN_KNOWN_SYMBOLS,
  fetchBinancePrices,
  fetchBitstampPrices,
  fetchCoinbasePrices,
  fetchKrakenPrices,
} from "../lib/cex-tickers";
import { fetchRedstonePrices, REDSTONE_TRACKED_SYMBOL_ALLOWLIST } from "../lib/redstone";
import { loadDexPriceRows, isTrustedDexPriceRow, loadDexPoolChallengers, loadDexPriceSources } from "../lib/depeg-helpers";
import { fetchCurveOnchainPrices } from "../lib/curve-onchain";
import { CURVE_POOL_CONFIGS } from "../lib/curve-pool-configs";
import { CRVUSD_PRICE_AGGREGATOR, CRVUSD_PRICE_SELECTOR } from "../lib/authoritative-price-sources";
import { fetchEvmCallHexAtBlock } from "../lib/evm-rpc";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { computePriceConsensus, type SourcePrice } from "../lib/price-consensus";
import {
  isGtProbeEligibleSingleSource,
  isPoolChallengeEligibleConsensus,
} from "../lib/pricing-source-policy";
import { buildPrimarySourceCandidates, type PrimaryCollectedQuotes } from "../lib/primary-price-collector";
import { aggregateProtocolPrices, computeWeightedMedianPrice } from "../lib/dex-price-estimators";
import type { PeggedAsset } from "./enrich-prices-shared";

export interface PrimaryPriceResult {
  price: number;
  source: string;
  selectedSource?: string;
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

function sumCirculatingUsd(asset: Pick<PeggedAsset, "circulating">): number {
  const circulating = asset.circulating;
  if (!circulating || typeof circulating !== "object") return 0;
  return Object.values(circulating).reduce(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

const INVALID_GECKO_ID_SENTINEL = "wrong";

function isUsableGeckoId(geckoId: unknown): geckoId is string {
  return typeof geckoId === "string" && geckoId.length > 0 && !geckoId.includes(INVALID_GECKO_ID_SENTINEL);
}

function getSourceDefaultWeight(source: string): number {
  return getPricingSourceRegistryEntry(source)?.defaultWeight ?? 1;
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
  dlListPrices?: Map<string, number>,
): Promise<{ results: Map<string, PrimaryPriceResult>; stats: PriceValidationStats; cgPrices: Map<string, number> }> {
  throwIfAborted(signal);
  const results = new Map<string, PrimaryPriceResult>();
  const stats: PriceValidationStats = { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 };
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
  if (candidates.length === 0) return { results, stats, cgPrices: new Map() };

  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES);
  const pythAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.PYTH_PRICES);
  const binanceAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES);
  const krakenAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.KRAKEN_PRICES);
  const bitstampAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.BITSTAMP_PRICES);
  const coinbaseAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.COINBASE_PRICES);
  const redstoneAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.REDSTONE_PRICES);
  const curveAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN);

  if (!cgAllowed && !pythAllowed && !binanceAllowed && !krakenAllowed && !bitstampAllowed && !coinbaseAllowed && !redstoneAllowed && !curveAllowed) {
    console.warn("[primary-prices] All live primary fetch circuits are open; continuing with local DL/DEX inputs only");
  }

  const geckoIds = [...new Set(
    candidates
      .map((asset) => asset.geckoId)
      .filter(isUsableGeckoId),
  )];
  const BATCH_SIZE = 250;

  const cgPrices = new Map<string, number>();

  const pythFeedIds = new Map<string, string>();
  for (const asset of candidates) {
    const meta = metaById.get(asset.id);
    if (meta?.pythFeedId) {
      pythFeedIds.set(asset.id, meta.pythFeedId);
    }
  }
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

  const candidateSymbolsUpper = [...new Set(candidates.map((a) => a.symbol.toUpperCase()))];
  const coinbaseSymbols = candidateSymbolsUpper.filter((s) => coinbaseKnownSet.has(s));
  const krakenSymbols = candidateSymbolsUpper.filter((s) => krakenKnownSet.has(s));
  const shouldFetchBitstamp = candidateSymbolsUpper.some((symbol) => bitstampKnownSet.has(symbol));
  const redstoneSymbols = [...new Set(candidates.map((a) => a.symbol).filter((symbol) => redstoneSymbolSet.has(symbol)))];

  const fetches: Promise<void>[] = [];

  if (cgAllowed) {
    fetches.push(
      (async () => {
        try {
          let hadBatchFailure = false;
          for (let i = 0; i < geckoIds.length; i += BATCH_SIZE) {
            throwIfAborted(signal);
            const batch = geckoIds.slice(i, i + BATCH_SIZE);
            const ids = batch.join(",");
            const res = await fetchWithRetry(
              cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd`, coingeckoApiKey ?? null),
              {
                headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
                signal,
              },
            );
            if (res?.ok) {
              const data = (await res.json()) as Record<string, { usd?: number }>;
              for (const [gId, val] of Object.entries(data)) {
                if (val?.usd != null && val.usd > 0) {
                  cgPrices.set(gId, val.usd);
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

  const cgTickerAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_TICKER);
  if (cgTickerAllowed && CG_TICKER_COINS.length > 0) {
    fetches.push(
      (async () => {
        try {
          const prices = await fetchCgTickerPrices(CG_TICKER_COINS, coingeckoApiKey ?? null, signal);
          for (const [coinId, price] of prices) cgTickerPrices.set(coinId, price);
          if (prices.size > 0) cgTickerObservedAt = Math.floor(Date.now() / 1000);
          await recordOutcome(db, CIRCUIT_SOURCE.CG_TICKER, prices.size > 0);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] CG ticker API failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.CG_TICKER, false);
        }
      })(),
    );
  }

  if (pythAllowed && pythFeedIds.size > 0) {
    fetches.push(
      (async () => {
        try {
          const results = await fetchPythPrices(pythFeedIds, signal);
          for (const [coinId, result] of results) {
            pythPrices.set(coinId, {
              price: result.price,
              confidenceBps: result.confidenceBps,
              publishTime: result.publishTime,
            });
          }
          await recordOutcome(db, CIRCUIT_SOURCE.PYTH_PRICES, results.size > 0);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] Pyth Hermes API failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.PYTH_PRICES, false);
        }
      })(),
    );
  }

  if (binanceAllowed || krakenAllowed || bitstampAllowed || coinbaseAllowed) {
    fetches.push(
      (async () => {
        if (binanceAllowed) {
          try {
            const prices = await fetchBinancePrices(signal);
            for (const [symbol, price] of prices) binancePrices.set(symbol, price);
            if (prices.size > 0) binanceObservedAt = Math.floor(Date.now() / 1000);
            await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, prices.size > 0);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            console.warn("[primary-prices] Binance ticker failed:", err);
            await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, false);
          }
        }

        if (krakenAllowed && krakenSymbols.length > 0) {
          try {
            const prices = await fetchKrakenPrices(krakenSymbols, signal);
            for (const [symbol, price] of prices) krakenPrices.set(symbol, price);
            if (prices.size > 0) krakenObservedAt = Math.floor(Date.now() / 1000);
            await recordOutcome(db, CIRCUIT_SOURCE.KRAKEN_PRICES, prices.size > 0);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            console.warn("[primary-prices] Kraken ticker failed:", err);
            await recordOutcome(db, CIRCUIT_SOURCE.KRAKEN_PRICES, false);
          }
        }

        if (bitstampAllowed && shouldFetchBitstamp) {
          try {
            const prices = await fetchBitstampPrices(signal);
            for (const [symbol, price] of prices) bitstampPrices.set(symbol, price);
            if (prices.size > 0) bitstampObservedAt = Math.floor(Date.now() / 1000);
            await recordOutcome(db, CIRCUIT_SOURCE.BITSTAMP_PRICES, prices.size > 0);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            console.warn("[primary-prices] Bitstamp ticker failed:", err);
            await recordOutcome(db, CIRCUIT_SOURCE.BITSTAMP_PRICES, false);
          }
        }

        if (coinbaseAllowed && coinbaseSymbols.length > 0) {
          try {
            const prices = await fetchCoinbasePrices(coinbaseSymbols, signal);
            for (const [symbol, price] of prices) coinbasePrices.set(symbol, price);
            if (prices.size > 0) coinbaseObservedAt = Math.floor(Date.now() / 1000);
            await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, prices.size > 0);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            console.warn("[primary-prices] Coinbase ticker failed:", err);
            await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, false);
          }
        }
      })(),
    );
  }

  if (redstoneAllowed && redstoneSymbols.length > 0) {
    fetches.push(
      (async () => {
        try {
          const prices = await fetchRedstonePrices(redstoneSymbols, signal);
          for (const [symbol, result] of prices) {
            redstonePrices.set(symbol, {
              price: result.price,
              venueCount: result.venueCount,
              venueAgreementPct: result.venueAgreementPct,
              timestamp: result.timestamp,
            });
          }
          await recordOutcome(db, CIRCUIT_SOURCE.REDSTONE_PRICES, prices.size > 0);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] RedStone API failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.REDSTONE_PRICES, false);
        }
      })(),
    );
  }

  if (curveAllowed && CURVE_POOL_CONFIGS.length > 0) {
    fetches.push(
      (async () => {
        try {
          const prices = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, signal, chainRpcs);
          for (const [id, price] of prices) curvePrices.set(id, price);
          if (prices.size > 0) curveObservedAt = Math.floor(Date.now() / 1000);
          await recordOutcome(db, CIRCUIT_SOURCE.CURVE_ONCHAIN, prices.size > 0);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] Curve on-chain failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.CURVE_ONCHAIN, false);
        }
      })(),
    );
    fetches.push(
      (async () => {
        try {
          const hex = await fetchEvmCallHexAtBlock(
            "ethereum", CRVUSD_PRICE_AGGREGATOR, CRVUSD_PRICE_SELECTOR, "latest", { signal, chainRpcs },
          );
          if (hex) {
            const price = Number(BigInt(hex)) / 1e18;
            if (price > 0 && price < 10) {
              curveOraclePrice = price;
              curveOracleObservedAt = Math.floor(Date.now() / 1000);
            }
          }
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] crvUSD oracle failed:", err);
        }
      })(),
    );
  }

  await Promise.all(fetches);
  throwIfAborted(signal);

  const DIVERGENCE_THRESHOLD_BPS = 50;
  for (const asset of candidates) {
    const gId = isUsableGeckoId(asset.geckoId) ? asset.geckoId : null;
    const cg = gId ? (cgPrices.get(gId) ?? null) : null;
    const collectedQuotes: PrimaryCollectedQuotes = {
      cgPrice: cg,
      cgObservedAt,
      cgTickerPrice: cgTickerPrices.get(asset.id) ?? null,
      cgTickerObservedAt,
      dlListPrice: dlListPrices?.get(asset.id) ?? null,
      pythQuote: pythPrices.get(asset.id),
      binancePrice: binancePrices.get(asset.symbol.toUpperCase()) ?? null,
      binanceObservedAt,
      krakenPrice: krakenPrices.get(asset.symbol.toUpperCase()) ?? null,
      krakenObservedAt,
      bitstampPrice: bitstampPrices.get(asset.symbol.toUpperCase()) ?? null,
      bitstampObservedAt,
      coinbasePrice: coinbasePrices.get(asset.symbol.toUpperCase()) ?? null,
      coinbaseObservedAt,
      redstoneQuote: redstonePrices.get(asset.symbol),
      curvePrice: curvePrices.get(asset.id) ?? null,
      curveObservedAt,
      curveOraclePrice,
      curveOracleObservedAt,
      protocolSources: dexPriceSources.get(asset.id),
      dexAggregateQuote: (() => {
        const dexRow = dexRows.get(asset.id);
        return dexRow && isTrustedDexPriceRow(dexRow, nowSec, "depeg") ? dexRow : undefined;
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

    stats.attempted++;

    const context = buildPriceValidationContext({
      stablecoinId: String(asset.id),
      pegType: asset.pegType,
      navToken: asset.navToken,
      commodityOunces: asset.commodityOunces,
    });
    const pegRef = context.navToken ? null : getReferencePriceForContext(context, references);
    const consensus = computePriceConsensus(sources, pegRef, DIVERGENCE_THRESHOLD_BPS, {
      mode: context.navToken ? "nav" : "fixed",
    });

    if (!consensus) continue;

    results.set(asset.id, {
      price: consensus.price,
      source: consensus.source,
      selectedSource: consensus.selectedSource,
      confidence: consensus.confidence,
      dlPrice: dlListPrices?.get(asset.id) ?? null,
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

    if (consensus.confidence === "high") stats.high++;
    else if (consensus.confidence === "single-source") stats.singleSource++;
    else stats.low++;

    if (consensus.confidence === "single-source" && consensus.source === "coingecko") {
      stats.cgOnly++;
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

  for (const result of results.values()) {
    if (
      result.confidence === "high" &&
      result.agreeSources.length === 2 &&
      result.agreeSources.every((s) => s === "coingecko" || s === "defillama-list")
    ) {
      result.confidence = "single-source";
      stats.high--;
      stats.singleSource++;
    }
  }

  const poolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, nowSec);
  const assetPegTypes = new Map(candidates.map((a) => [a.id, a.pegType]));
  const poolChallengeDowngrades = applyPoolChallenge(results, poolChallengers, assetPegTypes, stats);
  if (poolChallengeDowngrades > 0) {
    console.log(`[primary-prices] Pool challenge hardened ${poolChallengeDowngrades} soft-only result(s)`);
  }

  for (const result of results.values()) {
    const challengeSources = result.confidence === "low" ? result.candidateSources : result.agreeSources;
    if (isPoolChallengeEligibleConsensus(challengeSources)) {
      result.softOnly = true;
    }
  }

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

  return { results, stats, cgPrices };
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
): number {
  let downgrades = 0;
  for (const [assetId, result] of results) {
    if (result.confidence !== "high" && result.confidence !== "single-source" && result.confidence !== "low") continue;
    const challengeSources = result.confidence === "low" ? result.candidateSources : result.agreeSources;
    if (!isPoolChallengeEligibleConsensus(challengeSources)) continue;

    const pools = poolChallengers.get(assetId);
    if (!pools?.length) continue;

    const pegType = assetPegTypes.get(assetId);
    const poolChallengeBps = pegType === "peggedUSD"
      ? 500
      : Math.min(getDepegThresholdBps(pegType) * 2, 500);

    const divergingProtocols = new Set<string>();
    for (const pool of pools) {
      const mid = (result.price + pool.price) / 2;
      if (mid <= 0) continue;
      const bps = Math.abs(result.price - pool.price) / mid * 10_000;
      if (bps >= poolChallengeBps) {
        divergingProtocols.add(pool.protocol);
      }
    }
    if (divergingProtocols.size > 0) {
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

      if (divergingProtocols.size >= 2) {
        const divergentPoolGroups = aggregateProtocolPrices(
          pools
            .filter((pool) => divergingProtocols.has(pool.protocol))
            .map((pool) => ({
              protocol: pool.protocol,
              price: pool.price,
              tvl: pool.tvlUsd,
              chain: pool.chain,
              observedAt: pool.observedAt,
            })),
        );
        const replacementPrice = computeWeightedMedianPrice(
          divergentPoolGroups.map((group) => ({
            price: group.price,
            weight: group.tvl,
          })),
        );
        if (replacementPrice != null) {
          result.price = replacementPrice;
          result.source = "pool-tvl-weighted";
          result.selectedSource = "pool-tvl-weighted";
          const poolObservedAts = divergentPoolGroups
            .map((group) => group.observedAt)
            .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          result.observedAt = poolObservedAts.length > 0
            ? Math.min(...poolObservedAts)
            : result.observedAt;
          result.observedAtMode = "local_fetch";
        }
      }
    }
  }
  return downgrades;
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
): Promise<{ updatedCount: number; stats: import("../lib/geckoterminal-price-probe").GtProbeStats }> {
  const { createEmptyGtProbeStats, probeGeckoTerminalPrices } = await import("../lib/geckoterminal-price-probe");

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
        priorityUsd: sumCirculatingUsd(asset),
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
