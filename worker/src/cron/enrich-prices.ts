import { USER_AGENT, CIRCUIT_SOURCE, DEX_FRESHNESS_SEC, POOL_CHALLENGE_MIN_TVL, getDepegThresholdBps } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getCache } from "../lib/db-cache";
import { throwIfAborted } from "../lib/abort";
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

export { buildPriceReasonablenessOptions, isReasonablePrice, PRICE_BOUNDS };

export interface DefiLlamaCoinPrice {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
}

export interface PeggedAsset {
  id: string;
  name: string;
  symbol: string;
  address?: string;
  geckoId?: string;
  /** Snake-case alias for geckoId as returned by the DL stablecoins API. Normalized by hydrateGeckoIdAliases. */
  gecko_id?: string;
  cmcSlug?: string;
  navToken?: boolean;
  commodityOunces?: number;
  price?: number | null;
  priceSource?: string;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  supplySource?: string;
  pegType?: string;
  pegMechanism?: string;
  circulating?: Record<string, number>;
  circulatingPrevDay?: Record<string, number> | null;
  circulatingPrevWeek?: Record<string, number> | null;
  circulatingPrevMonth?: Record<string, number> | null;
  chains?: string[];
  chainCirculating?: Record<string, Record<string, unknown>>;
  consensusSources?: string[];
  agreeSources?: string[];
}

export function hasMissingPrice(a: PeggedAsset): boolean {
  return a.price == null || typeof a.price !== "number" || a.price === 0;
}

export function applyResolvedPrice(
  asset: PeggedAsset,
  price: number,
  source: string,
  confidence: PriceConfidence,
  updatedAtSec = Math.floor(Date.now() / 1000),
): void {
  asset.price = price;
  asset.priceSource = source;
  asset.priceConfidence = confidence;
  asset.priceUpdatedAt = updatedAtSec;
  asset.consensusSources = [source];
}

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
  confidence: PriceConfidence;
  dlPrice: number | null;
  cgPrice: number | null;
  candidateSources: string[];
  agreeSources: string[];
  softOnly?: boolean;
}

export interface PriceValidationStats {
  attempted: number;
  high: number;
  singleSource: number;
  cgOnly: number;
  low: number;
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

  // Only consider assets with a valid geckoId (no "wrong" tag)
  const candidates = assets.filter(
    (a) => a.geckoId && typeof a.geckoId === "string" && !a.geckoId.includes("wrong"),
  );
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
    console.warn("[primary-prices] All primary price circuits are open, skipping");
    return { results, stats, cgPrices: new Map() };
  }

  // Batch fetch sources in parallel
  const geckoIds = candidates.map((a) => a.geckoId!);
  const BATCH_SIZE = 250; // CG supports 250 IDs per call

  const cgPrices = new Map<string, number>();

  // Build Pyth feed map from tracked stablecoin metadata
  const metaById = new Map(ACTIVE_STABLECOINS.map((m) => [m.id, m]));
  const pythFeedIds = new Map<string, string>();
  for (const asset of candidates) {
    const meta = metaById.get(asset.id);
    if (meta?.pythFeedId) {
      pythFeedIds.set(asset.id, meta.pythFeedId);
    }
  }
  const pythPrices = new Map<string, { price: number; confidenceBps: number }>();
  const binancePrices = new Map<string, number>();
  const krakenPrices = new Map<string, number>();
  const bitstampPrices = new Map<string, number>();
  const coinbasePrices = new Map<string, number>();
  const redstonePrices = new Map<string, { price: number; venueCount: number; venueAgreementPct: number }>();
  const curvePrices = new Map<string, number>();
  let curveOraclePrice: number | null = null; // crvUSD PriceAggregator TWAP

  // Coinbase uses uppercased product symbols. RedStone is exact-case and only
  // queried for the known-supported tracked subset to keep request volume bounded.
  const candidateSymbolsUpper = [...new Set(candidates.map((a) => a.symbol.toUpperCase()))];
  const coinbaseKnownSet = new Set(COINBASE_KNOWN_SYMBOLS);
  const coinbaseSymbols = candidateSymbolsUpper.filter((s) => coinbaseKnownSet.has(s));
  const krakenKnownSet = new Set(KRAKEN_KNOWN_SYMBOLS);
  const krakenSymbols = candidateSymbolsUpper.filter((s) => krakenKnownSet.has(s));
  const bitstampKnownSet = new Set(BITSTAMP_KNOWN_SYMBOLS);
  const shouldFetchBitstamp = candidateSymbolsUpper.some((symbol) => bitstampKnownSet.has(symbol));
  const redstoneSymbolSet = new Set<string>(REDSTONE_TRACKED_SYMBOL_ALLOWLIST);
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
            pythPrices.set(coinId, { price: result.price, confidenceBps: result.confidenceBps });
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
            if (price > 0 && price < 10) curveOraclePrice = price;
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

  // Load DEX prices for promotion into primary consensus
  const nowSec = Math.floor(Date.now() / 1000);
  const dexRows = await loadDexPriceRows(db);
  const dexPriceSources = await loadDexPriceSources(db);

  // N-source consensus per asset
  const DIVERGENCE_THRESHOLD_BPS = 50;
  const DEX_API_WEIGHTS: Record<string, number> = { fluid: 3, balancer: 3, raydium: 2, orca: 2 };

  for (const asset of candidates) {
    const gId = asset.geckoId!;
    const cg = cgPrices.get(gId) ?? null;
    const pyth = pythPrices.get(asset.id);

    const sources: SourcePrice[] = [];
    if (cg != null) sources.push({ source: "coingecko", price: cg, weight: 2 });
    const dlListPrice = dlListPrices?.get(asset.id);
    if (dlListPrice != null && dlListPrice > 0) {
      sources.push({ source: "defillama-list", price: dlListPrice, weight: 1 });
    }
    if (pyth != null) {
      const pythWeight = pyth.confidenceBps > 200 ? 0 : pyth.confidenceBps > 100 ? 1 : 2;
      if (pythWeight > 0) {
        sources.push({ source: "pyth", price: pyth.price, weight: pythWeight, metadata: { confidenceBps: pyth.confidenceBps } });
      }
    }
    const binancePrice = binancePrices.get(asset.symbol.toUpperCase());
    if (binancePrice != null) sources.push({ source: "binance", price: binancePrice, weight: 2 });
    const krakenPrice = krakenPrices.get(asset.symbol.toUpperCase());
    if (krakenPrice != null) sources.push({ source: "kraken", price: krakenPrice, weight: 2 });
    const bitstampPrice = bitstampPrices.get(asset.symbol.toUpperCase());
    if (bitstampPrice != null) sources.push({ source: "bitstamp", price: bitstampPrice, weight: 1 });
    const coinbasePrice = coinbasePrices.get(asset.symbol.toUpperCase());
    if (coinbasePrice != null) sources.push({ source: "coinbase", price: coinbasePrice, weight: 2 });
    const redstoneResult = redstonePrices.get(asset.symbol);
    if (redstoneResult != null && redstoneResult.venueAgreementPct >= 50) {
      sources.push({
        source: "redstone",
        price: redstoneResult.price,
        weight: 1,
        metadata: { venueCount: redstoneResult.venueCount, venueAgreementPct: redstoneResult.venueAgreementPct },
      });
    }
    const curvePrice = curvePrices.get(asset.id);
    if (curvePrice != null) sources.push({ source: "curve-onchain", price: curvePrice, weight: 3 });
    if (asset.id === "crvusd-curve" && curveOraclePrice != null) {
      sources.push({ source: "curve-oracle", price: curveOraclePrice, weight: 3 });
    }
    const dexRow = dexRows.get(asset.id);
    if (dexRow && isTrustedDexPriceRow(dexRow, nowSec, "depeg")) {
      sources.push({
        source: "dex-promoted",
        price: dexRow.dex_price_usd,
        weight: 1,
        metadata: { poolCount: dexRow.source_pool_count, tvl: dexRow.source_total_tvl },
      });
    }

    // Disaggregate per-protocol prices from dex_prices.price_sources_json
    const protocolSources = dexPriceSources.get(asset.id);
    if (protocolSources) {
      for (const ps of protocolSources) {
        const w = DEX_API_WEIGHTS[ps.protocol];
        if (w == null) continue; // only inject for protocols with elevated weights
        if (ps.tvl < 50_000) continue; // min TVL for pricing
        if (!Number.isFinite(ps.price) || ps.price <= 0) continue;
        sources.push({
          source: `${ps.protocol}-dex`,
          price: ps.price,
          weight: w,
          metadata: { tvl: ps.tvl, chain: ps.chain },
        });
      }
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
      confidence: consensus.confidence,
      dlPrice: dlListPrices?.get(asset.id) ?? null,
      cgPrice: cg ?? null,
      candidateSources: sources.map((s) => s.source),
      agreeSources: consensus.agreeSources,
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

  // --- Pool challenge pass ---
  const poolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, nowSec);
  const assetPegTypes = new Map(candidates.map((a) => [a.id, a.pegType]));
  const poolChallengeDowngrades = applyPoolChallenge(results, poolChallengers, assetPegTypes, stats);
  if (poolChallengeDowngrades > 0) {
    console.log(`[primary-prices] Pool challenge downgraded ${poolChallengeDowngrades} soft-only results to low confidence`);
  }

  // Downgrade CG+DL-only "high" to "single-source" — these soft aggregators
  // may share upstream data, creating illusory agreement. Runs after pool
  // challenge so pool-challenged assets get caught at "high" confidence first.
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

    // Annotate soft-only high-confidence results for observability
    if (result.confidence === "high" && isAllSoftSources(result.agreeSources)) {
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
  poolChallengers: Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string }>>,
  assetPegTypes: Map<string, string | undefined>,
  stats: PriceValidationStats,
): number {
  let downgrades = 0;
  for (const [assetId, result] of results) {
    if (result.confidence !== "high") continue;
    if (!isAllSoftSources(result.agreeSources)) continue;

    const pools = poolChallengers.get(assetId);
    if (!pools?.length) continue;

    const pegType = assetPegTypes.get(assetId);
    const poolChallengeBps = pegType === "peggedUSD"
      ? 500
      : Math.min(getDepegThresholdBps(pegType) * 2, 500);

    let challenged = false;
    for (const pool of pools) {
      const mid = (result.price + pool.price) / 2;
      if (mid <= 0) continue;
      const bps = Math.abs(result.price - pool.price) / mid * 10_000;
      if (bps >= poolChallengeBps) {
        challenged = true;
        break;
      }
    }
    if (challenged) {
      result.confidence = "low";
      stats.high--;
      stats.low++;
      downgrades++;

      let tvlWeightedSum = 0;
      let tvlSum = 0;
      for (const pool of pools) {
        tvlWeightedSum += pool.price * pool.tvlUsd;
        tvlSum += pool.tvlUsd;
      }
      if (tvlSum > 0) {
        result.price = tvlWeightedSum / tvlSum;
        result.source = "pool-tvl-weighted";
      }
    }
  }
  return downgrades;
}

/** Sources that are independent exchanges/oracles — NOT aggregators that may share upstream data */
const HARD_SOURCES = new Set([
  "pyth", "binance", "kraken", "bitstamp", "coinbase", "curve-onchain", "curve-oracle", "redstone", "protocol-redeem",
  "fluid-dex", "balancer-dex", "raydium-dex", "orca-dex",
]);

/** Returns true if all sources are soft aggregators (CG, DL, DEX average, etc.) */
function isAllSoftSources(sources: string[]): boolean {
  return sources.length > 0 && sources.every((s) => !HARD_SOURCES.has(s));
}

/**
 * For assets that are single-source CG-only after primary consensus,
 * probe GeckoTerminal for an independent pool-level price and re-run
 * consensus with the additional source.
 */
export async function runGtProbePass(
  assets: PeggedAsset[],
  primaryResults: Map<string, PrimaryPriceResult>,
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
): Promise<{ updatedCount: number; stats: import("../lib/geckoterminal-price-probe").GtProbeStats }> {
  const { probeGeckoTerminalPrices } = await import("../lib/geckoterminal-price-probe");

  // Identify single-source CG-only assets
  const cgOnlyAssets: { id: string; price: number }[] = [];
  for (const asset of assets) {
    const primary = primaryResults.get(asset.id);
    if (
      primary &&
      primary.confidence === "single-source" &&
      primary.candidateSources.length === 1 &&
      primary.candidateSources[0] === "coingecko"
    ) {
      cgOnlyAssets.push({ id: asset.id, price: primary.price });
    }
  }

  if (cgOnlyAssets.length === 0) {
    return { updatedCount: 0, stats: { probed: 0, pricesObtained: 0, divergences500bps: 0, skippedLowTvl: 0 } };
  }

  const { prices: gtPrices, stats } = await probeGeckoTerminalPrices(cgOnlyAssets, db, signal);

  // Re-run consensus for assets that got a GT price
  let updatedCount = 0;
  for (const asset of assets) {
    const gtSource = gtPrices.get(asset.id);
    if (!gtSource) continue;

    const primary = primaryResults.get(asset.id);
    if (!primary) continue;

    // Build source list: original CG + GT
    const sources: SourcePrice[] = [
      { source: "coingecko", price: primary.cgPrice ?? primary.price, weight: 2 },
      gtSource,
    ];

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
    primary.confidence = consensus.confidence;
    primary.candidateSources = sources.map((s) => s.source);
    primary.agreeSources = consensus.agreeSources;
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
    // ── Pass 2: CoinMarketCap listings batch ──
    const cmcResult = await runCmcPass(assets, cmcApiKey, fxRates, db, signal);
    passCmcCount = cmcResult.resolved;

    // ── Pass 3: Jupiter Price API (Solana-only fallback) ──
    const jupiterResult = await runJupiterPass(assets, fxRates, db, signal);
    passJupiterCount = jupiterResult.resolved;

    // ── Pass 4: DexScreener search API (best-effort fallback) ──
    const dexResult = await runDexScreenerPass(assets, fxRates, db, signal);
    passDexCount = dexResult.resolved;

    // ── Summary log ──
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
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] Price enrichment failed:", err);
    failedPasses.push("passes-2-4");
    return {
      totalMissing,
      pass1: pass1Count,
      pass1b: pass1bCount,
      passCmc: passCmcCount,
      passJupiter: passJupiterCount,
      passDex: passDexCount,
      finalMissing: totalMissing,
      failedPasses,
    };
  }
}
