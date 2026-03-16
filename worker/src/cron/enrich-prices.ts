import { USER_AGENT, CIRCUIT_SOURCE, DEX_FRESHNESS_SEC } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getCache } from "../lib/db-cache";
import { throwIfAborted } from "../lib/abort";
import { runDlContractPasses, runCmcPass, runDexScreenerPass } from "./enrich-prices-passes";
import type { PriceConfidence } from "@shared/types";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  buildPriceValidationContext,
  buildPriceReasonablenessOptions,
  getReferencePriceForContext,
  isReasonablePrice,
  PRICE_BOUNDS,
  type PriceValidationReferences,
} from "../lib/price-validation";
import { fetchPythPrices } from "../lib/pyth";
import { fetchBinancePrices, fetchCoinbasePrices, COINBASE_KNOWN_SYMBOLS } from "../lib/cex-tickers";
import { fetchRedstonePrices, REDSTONE_TRACKED_SYMBOL_ALLOWLIST } from "../lib/redstone";
import { loadDexPriceRows, isTrustedDexPriceRow, loadDexPoolChallengers } from "../lib/depeg-helpers";
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
 *   3. DexScreener search API (best-effort)
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
  const coinbaseAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.COINBASE_PRICES);
  const redstoneAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.REDSTONE_PRICES);
  const curveAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN);

  if (!cgAllowed && !pythAllowed && !binanceAllowed && !coinbaseAllowed && !redstoneAllowed && !curveAllowed) {
    console.warn("[primary-prices] All primary price circuits are open, skipping");
    return { results, stats, cgPrices: new Map() };
  }

  // Batch fetch sources in parallel
  const geckoIds = candidates.map((a) => a.geckoId!);
  const BATCH_SIZE = 250; // CG supports 250 IDs per call

  const cgPrices = new Map<string, number>();

  // Build Pyth feed map from tracked stablecoin metadata
  const metaById = new Map(TRACKED_STABLECOINS.map((m) => [m.id, m]));
  const pythFeedIds = new Map<string, string>();
  for (const asset of candidates) {
    const meta = metaById.get(asset.id);
    if (meta?.pythFeedId) {
      pythFeedIds.set(asset.id, meta.pythFeedId);
    }
  }
  const pythPrices = new Map<string, { price: number; confidenceBps: number }>();
  const binancePrices = new Map<string, number>();
  const coinbasePrices = new Map<string, number>();
  const redstonePrices = new Map<string, { price: number; venueCount: number; venueAgreementPct: number }>();
  const curvePrices = new Map<string, number>();
  let curveOraclePrice: number | null = null; // crvUSD PriceAggregator TWAP

  // Coinbase uses uppercased product symbols. RedStone is exact-case and only
  // queried for the known-supported tracked subset to keep request volume bounded.
  const coinbaseKnownSet = new Set(COINBASE_KNOWN_SYMBOLS);
  const coinbaseSymbols = [...new Set(
    candidates.map((a) => a.symbol.toUpperCase()).filter((s) => coinbaseKnownSet.has(s)),
  )];
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

  if (binanceAllowed) {
    fetches.push(
      (async () => {
        try {
          const prices = await fetchBinancePrices(signal);
          for (const [symbol, price] of prices) binancePrices.set(symbol, price);
          await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, prices.size > 0);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] Binance ticker failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, false);
        }
      })(),
    );
  }

  if (coinbaseAllowed) {
    fetches.push(
      (async () => {
        try {
          const prices = await fetchCoinbasePrices(coinbaseSymbols, signal);
          for (const [symbol, price] of prices) coinbasePrices.set(symbol, price);
          await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, prices.size > 0);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] Coinbase ticker failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, false);
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

  // N-source consensus per asset
  const DIVERGENCE_THRESHOLD_BPS = 50;

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
    if (pyth != null) sources.push({ source: "pyth", price: pyth.price, weight: 2, metadata: { confidenceBps: pyth.confidenceBps } });
    const binancePrice = binancePrices.get(asset.symbol.toUpperCase());
    if (binancePrice != null) sources.push({ source: "binance", price: binancePrice, weight: 2 });
    const coinbasePrice = coinbasePrices.get(asset.symbol.toUpperCase());
    if (coinbasePrice != null) sources.push({ source: "coinbase", price: coinbasePrice, weight: 2 });
    const redstoneResult = redstonePrices.get(asset.symbol);
    if (redstoneResult != null) {
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

    stats.attempted++;

    const context = buildPriceValidationContext({
      stablecoinId: String(asset.id),
      pegType: asset.pegType,
      navToken: asset.navToken,
      commodityOunces: asset.commodityOunces,
    });
    const pegRef = context.navToken ? null : getReferencePriceForContext(context, references);
    const consensus = computePriceConsensus(sources, pegRef, DIVERGENCE_THRESHOLD_BPS);

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
  }

  // --- Pool challenge pass ---
  // For high-confidence results built entirely from soft aggregator sources,
  // check if ANY large DEX pool diverges significantly. If so, the
  // aggregators may all be pricing from small misleading pools while
  // ignoring large pools that show a depeg.
  const POOL_CHALLENGE_BPS = 500; // 5% divergence threshold
  const POOL_CHALLENGE_MIN_TVL = 100_000; // $100K minimum pool TVL for challenger
  const poolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, nowSec);

  let poolChallengeDowngrades = 0;
  for (const [assetId, result] of results) {
    if (result.confidence !== "high") continue;
    if (!isAllSoftSources(result.agreeSources)) continue;

    const pools = poolChallengers.get(assetId);
    if (!pools?.length) continue;

    // Check if ANY qualifying pool diverges from consensus
    let challenged = false;
    for (const pool of pools) {
      const mid = (result.price + pool.price) / 2;
      if (mid <= 0) continue;
      const bps = Math.abs(result.price - pool.price) / mid * 10_000;
      if (bps >= POOL_CHALLENGE_BPS) {
        challenged = true;
        break; // one divergent pool is enough
      }
    }
    if (challenged) {
      result.confidence = "low";
      stats.high--;
      stats.low++;
      poolChallengeDowngrades++;

      // Replace soft-only consensus price with TVL-weighted mean of individual pools.
      // When aggregators agree on a misleading price, on-chain pool liquidity is
      // a more honest signal — large pools carry proportional weight.
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
  if (poolChallengeDowngrades > 0) {
    console.log(`[primary-prices] Pool challenge downgraded ${poolChallengeDowngrades} soft-only results to low confidence`);
  }

  console.log(
    `[primary-prices] ${stats.attempted} assets: ${stats.high} high, ${stats.singleSource} single-source, ${stats.low} low confidence`,
  );

  return { results, stats, cgPrices };
}

/** Sources that are independent exchanges/oracles — NOT aggregators that may share upstream data */
const HARD_SOURCES = new Set([
  "pyth", "binance", "coinbase", "curve-onchain", "curve-oracle", "redstone", "protocol-redeem",
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
    const consensus = computePriceConsensus(sources, pegRef, 50);

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
  if (totalMissing === 0) return { totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passDex: 0, finalMissing: 0, failedPasses: [] };

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
  let passDexCount = 0;

  try {
    // ── Pass 2: CoinMarketCap listings batch ──
    const cmcResult = await runCmcPass(assets, cmcApiKey, fxRates, db, signal);
    passCmcCount = cmcResult.resolved;

    // ── Pass 3: DexScreener search API (best-effort fallback) ──
    const dexResult = await runDexScreenerPass(assets, fxRates, db, signal);
    passDexCount = dexResult.resolved;

    // ── Summary log ──
    const finalMissing = assets.filter(hasMissingPrice).length;
    const totalEnriched = pass1Count + pass1bCount + passCmcCount + passDexCount;
    if (totalMissing > 0) {
      console.log(
        `[enrich] ${totalMissing} assets missing prices → ` +
        `Pass 1: +${pass1Count}, Pass 1b (multi-chain): +${pass1bCount}, ` +
        `Pass 2 (CMC): +${passCmcCount}, ` +
        `Pass 3 (DexScreener): +${passDexCount}, still missing: ${finalMissing}`
      );
    }
    if (totalEnriched > 0) {
      console.log(`[sync-stablecoins] Enriched prices for ${totalEnriched} assets`);
    }
    return { totalMissing, pass1: pass1Count, pass1b: pass1bCount, passCmc: passCmcCount, passDex: passDexCount, finalMissing, failedPasses };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] Price enrichment failed:", err);
    failedPasses.push("passes-2-3");
    return { totalMissing, pass1: pass1Count, pass1b: pass1bCount, passCmc: passCmcCount, passDex: passDexCount, finalMissing: totalMissing, failedPasses };
  }
}
