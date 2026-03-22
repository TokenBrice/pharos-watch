import { USER_AGENT, CIRCUIT_SOURCE, DEX_FRESHNESS_SEC, POOL_CHALLENGE_MIN_TVL, getDepegThresholdBps } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getCache } from "../lib/db-cache";
import { throwIfAborted } from "../lib/abort";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";
import { runDlContractPasses, runCmcPass, runDexScreenerPass, runJupiterPass } from "./enrich-prices-passes";
import type { PriceConfidence } from "@shared/types";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  buildPriceValidationContext,
  buildPriceReasonablenessOptions,
  getReferencePriceForContext,
  isReasonablePrice,
  PRICE_BOUNDS,
  type PriceValidationReferences,
} from "../lib/price-validation";
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
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";

export { buildPriceReasonablenessOptions, isReasonablePrice, PRICE_BOUNDS };

export interface DefiLlamaCoinPrice {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
}
export type { PeggedAsset } from "./enrich-prices-shared";
export { applyResolvedPrice, hasMissingPrice } from "./enrich-prices-shared";

/**
 * Enrich assets that are missing prices via a 4-pass pipeline:
 *   1. Contract addresses via DefiLlama coins API
 *   1b. Multi-chain contract fallback
 *   2. CoinMarketCap API (rate-limited)
 *   3. Jupiter Price API for supported Solana assets
 *   4. DexScreener exact token-address pools, then symbol search (best-effort)
 *
 * Individual pass logic lives in ./enrich-prices-passes.ts.
 */
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
  observedAtBySource?: Record<string, number | null>;
  softOnly?: boolean;
}

export interface PriceValidationStats {
  attempted: number;
  high: number;
  singleSource: number;
  cgOnly: number;
  low: number;
}

function pricesAgreeWithinBps(left: number, right: number, thresholdBps: number): boolean {
  const mid = (left + right) / 2;
  if (mid <= 0) return false;
  return (Math.abs(left - right) / mid) * 10000 <= thresholdBps;
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

  // Batch fetch sources in parallel
  const geckoIds = [...new Set(
    candidates
      .map((asset) => asset.geckoId)
      .filter(isUsableGeckoId),
  )];
  const BATCH_SIZE = 250; // CG supports 250 IDs per call

  const cgPrices = new Map<string, number>();

  // Build Pyth feed map from tracked stablecoin metadata
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
  let curveOraclePrice: number | null = null; // crvUSD PriceAggregator TWAP
  let cgObservedAt: number | null = null;
  let binanceObservedAt: number | null = null;
  let krakenObservedAt: number | null = null;
  let bitstampObservedAt: number | null = null;
  let coinbaseObservedAt: number | null = null;
  let curveObservedAt: number | null = null;
  let curveOracleObservedAt: number | null = null;

  // Coinbase uses uppercased product symbols. RedStone is exact-case and only
  // queried for the known-supported tracked subset to keep request volume bounded.
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
          // CG /simple/price supports up to 250 IDs per call
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
    // crvUSD PriceAggregator TWAP oracle — separate from pool get_dy
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

  // N-source consensus per asset
  const DIVERGENCE_THRESHOLD_BPS = 50;
  const DEX_API_WEIGHTS: Record<string, number> = { fluid: 3, balancer: 3, raydium: 2, orca: 2 };

  for (const asset of candidates) {
    const gId = isUsableGeckoId(asset.geckoId) ? asset.geckoId : null;
    const cg = gId ? (cgPrices.get(gId) ?? null) : null;
    const pyth = pythPrices.get(asset.id);

    const sources: SourcePrice[] = [];
    if (cg != null) sources.push({ source: "coingecko", price: cg, weight: 2, observedAt: cgObservedAt });
    const dlListPrice = dlListPrices?.get(asset.id);
    if (dlListPrice != null && dlListPrice > 0) {
      sources.push({
        source: "defillama-list",
        price: dlListPrice,
        weight: 1,
        observedAt: asset.priceObservedAt ?? asset.priceUpdatedAt ?? null,
      });
    }
    if (pyth != null) {
      const pythWeight = pyth.confidenceBps > 200 ? 0 : pyth.confidenceBps > 100 ? 1 : 2;
      if (pythWeight > 0) {
        sources.push({
          source: "pyth",
          price: pyth.price,
          weight: pythWeight,
          observedAt: pyth.publishTime,
          metadata: { confidenceBps: pyth.confidenceBps },
        });
      }
    }
    const binancePrice = binancePrices.get(asset.symbol.toUpperCase());
    if (binancePrice != null) sources.push({ source: "binance", price: binancePrice, weight: 2, observedAt: binanceObservedAt });
    const krakenPrice = krakenPrices.get(asset.symbol.toUpperCase());
    if (krakenPrice != null) sources.push({ source: "kraken", price: krakenPrice, weight: 2, observedAt: krakenObservedAt });
    const bitstampPrice = bitstampPrices.get(asset.symbol.toUpperCase());
    if (bitstampPrice != null) sources.push({ source: "bitstamp", price: bitstampPrice, weight: 1, observedAt: bitstampObservedAt });
    const coinbasePrice = coinbasePrices.get(asset.symbol.toUpperCase());
    if (coinbasePrice != null) sources.push({ source: "coinbase", price: coinbasePrice, weight: 2, observedAt: coinbaseObservedAt });
    const redstoneResult = redstonePrices.get(asset.symbol);
    if (redstoneResult != null && redstoneResult.venueCount >= 2 && redstoneResult.venueAgreementPct >= 50) {
      sources.push({
        source: "redstone",
        price: redstoneResult.price,
        weight: 1,
        observedAt: redstoneResult.timestamp,
        metadata: { venueCount: redstoneResult.venueCount, venueAgreementPct: redstoneResult.venueAgreementPct },
      });
    }
    const curvePrice = curvePrices.get(asset.id);
    if (curvePrice != null) sources.push({ source: "curve-onchain", price: curvePrice, weight: 3, observedAt: curveObservedAt });
    if (asset.id === "crvusd-curve" && curveOraclePrice != null) {
      sources.push({ source: "curve-oracle", price: curveOraclePrice, weight: 3, observedAt: curveOracleObservedAt });
    }
    const protocolSources = dexPriceSources.get(asset.id);
    const promotedDexProtocolSources: SourcePrice[] = [];
    if (protocolSources) {
      for (const ps of protocolSources) {
        const w = DEX_API_WEIGHTS[ps.protocol];
        if (w == null) continue; // only inject for protocols with elevated weights
        if (ps.tvl < 50_000) continue; // min TVL for pricing
        if (!Number.isFinite(ps.price) || ps.price <= 0) continue;
        promotedDexProtocolSources.push({
          source: `${ps.protocol}-dex`,
          price: ps.price,
          weight: w,
          observedAt: ps.updatedAt,
          metadata: { tvl: ps.tvl, chain: ps.chain },
        });
      }
    }
    const hasPromotedDexProtocolSource = promotedDexProtocolSources.length > 0;
    const hasDexCorroboration =
      promotedDexProtocolSources.length > 1 ||
      sources.length === 0 ||
      promotedDexProtocolSources.some((dexSource) =>
        sources.some((source) => pricesAgreeWithinBps(dexSource.price, source.price, DIVERGENCE_THRESHOLD_BPS))
      );
    if (hasPromotedDexProtocolSource && hasDexCorroboration) {
      sources.push(...promotedDexProtocolSources);
    } else if (hasPromotedDexProtocolSource) {
      console.log(
        `[primary-prices] ${asset.symbol}: suppressed ${promotedDexProtocolSources.length} uncorroborated promoted DEX source(s)`,
      );
    }

    // Keep the aggregate DEX bridge only when it is not overlapping with a promoted
    // per-protocol source from the same dex_prices observation family.
    const dexRow = dexRows.get(asset.id);
    if (dexRow && isTrustedDexPriceRow(dexRow, nowSec, "depeg") && !hasPromotedDexProtocolSource) {
      sources.push({
        source: "dex-promoted",
        price: dexRow.dex_price_usd,
        weight: 1,
        observedAt: dexRow.updated_at,
        metadata: { poolCount: dexRow.source_pool_count, tvl: dexRow.source_total_tvl },
      });
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

    if (!consensus) continue; // no sources

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
      observedAtBySource: consensus.observedAtBySource,
    });

    if (consensus.confidence === "high") stats.high++;
    else if (consensus.confidence === "single-source") stats.singleSource++;
    else stats.low++;

    // Track single-source breakdown
    if (consensus.confidence === "single-source") {
      if (consensus.source === "coingecko") stats.cgOnly++;
    }

    // Log when high-weight sources disagree — aids operational monitoring (IMPROVE-4)
    if (consensus.disagreeSources.length > 0) {
      const highWeightDisagrees = sources
        .filter((s) => s.weight >= 2 && consensus.disagreeSources.includes(s.source))
        .map((s) => `${s.source}($${s.price.toFixed(4)})`);
      if (highWeightDisagrees.length > 0) {
        console.log(
          `[primary-prices] ${asset.symbol}: high-weight disagree: ${highWeightDisagrees.join(", ")} ` +
          `vs consensus $${consensus.price.toFixed(4)}`,
        );
      }
    }
  }

  // Downgrade CG+DL-only "high" to "single-source" — these soft aggregators
  // may share upstream data, creating illusory agreement.
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

  // --- Pool challenge pass ---
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

  // Log coverage: how many candidates received a DL list price
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

    // Count how many pools diverge beyond the threshold AND how many
    // independent protocols those diverging pools span. A single pool
    // (or pools from a single protocol) can have data-quality issues
    // (e.g., vault-token counterparties producing misleading prices).
    // Require diverging pools from ≥2 independent protocols before
    // overriding consensus; otherwise only downgrade confidence.
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

      // Only replace the price when ≥2 independent protocols corroborate
      // the divergence — a single protocol's pools may share the same
      // data-quality issue (vault tokens, misconfigured pairs).
      if (divergingProtocols.size >= 2) {
        let tvlWeightedSum = 0;
        let tvlSum = 0;
        for (const pool of pools) {
          tvlWeightedSum += pool.price * pool.tvlUsd;
          tvlSum += pool.tvlUsd;
        }
        if (tvlSum > 0) {
          result.price = tvlWeightedSum / tvlSum;
          result.source = "pool-tvl-weighted";
          result.selectedSource = "pool-tvl-weighted";
          const poolObservedAts = pools
            .map((pool) => pool.observedAt)
            .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          result.observedAt = poolObservedAts.length > 0
            ? Math.min(...poolObservedAts)
            : result.observedAt;
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

  // Identify weak soft-source assets that can benefit from an independent GT pool check.
  const singleSourceAssets: Array<{ id: string; price: number }> = [];
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
      singleSourceAssets.push({ id: asset.id, price: primary.price });
    }
  }

  if (singleSourceAssets.length === 0) {
    return {
      updatedCount: 0,
      stats: createEmptyGtProbeStats(),
    };
  }

  const { prices: gtPrices, stats } = await probeGeckoTerminalPrices(singleSourceAssets, db, signal, coingeckoApiKey);

  // Re-run consensus for assets that got a GT price
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

    // Update the primary result
    primary.price = consensus.price;
    primary.source = consensus.source;
    primary.selectedSource = consensus.selectedSource;
    primary.confidence = consensus.confidence;
    primary.candidateSources = sources.map((s) => s.source);
    primary.agreeSources = consensus.agreeSources;
    primary.disagreeSources = consensus.disagreeSources;
    primary.allPrices = consensus.allPrices;
    primary.observedAt = consensus.observedAt;
    primary.observedAtBySource = consensus.observedAtBySource;
    updatedCount++;
  }

  return { updatedCount, stats };
}

export interface EnrichmentStats {
  totalMissing: number;
  pass1: number;
  pass1b: number;
  passCmc: number;
  passJupiter: number;
  passDex: number;
  finalMissing: number;
  failedPasses: string[];
}

export async function enrichMissingPrices(
  assets: PeggedAsset[],
  cmcApiKey?: string,
  db?: D1Database,
  signal?: AbortSignal,
): Promise<EnrichmentStats> {
  throwIfAborted(signal);
  const totalMissing = assets.filter(hasMissingPrice).length;
  if (totalMissing === 0) {
    return {
      totalMissing: 0,
      pass1: 0,
      pass1b: 0,
      passCmc: 0,
      passJupiter: 0,
      passDex: 0,
      finalMissing: 0,
      failedPasses: [],
    };
  }

  // Load FX rates once — shared across all passes for dynamic price bounds
  let fxRates: Record<string, number> | undefined;
  if (db) {
    try {
      const fxCache = await getCache(db, "fx-rates");
      if (fxCache) fxRates = JSON.parse(fxCache.value);
    } catch (e) {
      console.warn("[enrich-prices] Failed to load FX rates for price bounds:", e);
    }
  }

  const failedPasses: string[] = [];

  // ── Pass 1/1b: Contract addresses via DefiLlama coins API ──
  // Wrapped separately so DL failure does not abort CMC/DexScreener passes.
  const dlResult = await runDlContractPasses(assets, signal);
  const pass1Count = dlResult.pass1;
  const pass1bCount = dlResult.pass1b;
  failedPasses.push(...dlResult.failures);

  let passCmcCount = 0;
  let passJupiterCount = 0;
  let passDexCount = 0;

  try {
    const cmcResult = await runCmcPass(assets, cmcApiKey, fxRates, db, signal);
    passCmcCount = cmcResult.resolved;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] CoinMarketCap enrichment failed:", err);
    failedPasses.push("coinmarketcap");
  }

  try {
    const jupiterResult = await runJupiterPass(assets, fxRates, db, signal);
    passJupiterCount = jupiterResult.resolved;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] Jupiter enrichment failed:", err);
    failedPasses.push("jupiter");
  }

  try {
    const dexResult = await runDexScreenerPass(assets, fxRates, db, signal);
    passDexCount = dexResult.resolved;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] DexScreener enrichment failed:", err);
    failedPasses.push("dexscreener");
  }

  const finalMissing = assets.filter(hasMissingPrice).length;
  const totalEnriched = pass1Count + pass1bCount + passCmcCount + passJupiterCount + passDexCount;
  if (totalMissing > 0) {
    console.log(
      `[enrich] ${totalMissing} assets missing prices → ` +
      `Pass 1: +${pass1Count}, Pass 1b (multi-chain): +${pass1bCount}, ` +
      `Pass 2 (CMC): +${passCmcCount}, ` +
      `Pass 3 (Jupiter): +${passJupiterCount}, ` +
      `Pass 4 (DexScreener): +${passDexCount}, still missing: ${finalMissing}`
    );
  }
  if (totalEnriched > 0) {
    console.log(`[sync-stablecoins] Enriched prices for ${totalEnriched} assets`);
  }
  return {
    totalMissing,
    pass1: pass1Count,
    pass1b: pass1bCount,
    passCmc: passCmcCount,
    passJupiter: passJupiterCount,
    passDex: passDexCount,
    finalMissing,
    failedPasses,
  };
}
