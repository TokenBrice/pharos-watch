import { DEFILLAMA_COINS, USER_AGENT, CIRCUIT_SOURCE } from "../lib/constants";
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
import { loadDexPriceRows, isTrustedDexPriceRow } from "../lib/depeg-helpers";
import { fetchCurveOnchainPrices } from "../lib/curve-onchain";
import { CURVE_POOL_CONFIGS } from "../lib/curve-pool-configs";
import { CRVUSD_PRICE_AGGREGATOR, CRVUSD_PRICE_SELECTOR } from "../lib/authoritative-price-sources";
import { fetchEvmCallHexAtBlock } from "../lib/evm-rpc";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { computePriceConsensus, type SourcePrice } from "../lib/price-consensus";
import { DLPriceResponseSchema } from "../lib/schemas";

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
  dlOnly: number;
  low: number;
  divergences: { id: string; symbol: string; dlPrice: number; cgPrice: number; bps: number }[];
}

/**
 * Fetch prices from both DL coins API and CG direct API in parallel,
 * cross-validate within 50bps, and return a confidence-tagged result per asset.
 */
export async function fetchPrimaryPrices(
  assets: PeggedAsset[],
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<{ results: Map<string, PrimaryPriceResult>; stats: PriceValidationStats; cgPrices: Map<string, number> }> {
  throwIfAborted(signal);
  const results = new Map<string, PrimaryPriceResult>();
  const stats: PriceValidationStats = { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, dlOnly: 0, low: 0, divergences: [] };

  // Only consider assets with a valid geckoId (no "wrong" tag)
  const candidates = assets.filter(
    (a) => a.geckoId && typeof a.geckoId === "string" && !a.geckoId.includes("wrong"),
  );
  if (candidates.length === 0) return { results, stats, cgPrices: new Map() };

  const dlAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_COINS);
  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES);
  const pythAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.PYTH_PRICES);
  const binanceAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES);
  const coinbaseAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.COINBASE_PRICES);
  const redstoneAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.REDSTONE_PRICES);
  const curveAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_ONCHAIN);

  if (!dlAllowed && !cgAllowed && !pythAllowed && !binanceAllowed && !coinbaseAllowed && !redstoneAllowed && !curveAllowed) {
    console.warn("[primary-prices] All primary price circuits are open, skipping");
    return { results, stats, cgPrices: new Map() };
  }

  // Batch fetch sources in parallel
  const geckoIds = candidates.map((a) => a.geckoId!);
  const BATCH_SIZE = 250; // CG supports 250 IDs per call

  const dlPrices = new Map<string, number>();
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

  if (dlAllowed) {
    fetches.push(
      (async () => {
        try {
          // DL coins API accepts coingecko:id format, no batch limit
          const coinIds = geckoIds.map((id) => `coingecko:${id}`).join(",");
          const res = await fetchWithRetry(
            `${DEFILLAMA_COINS}/prices/current/${coinIds}`,
            signal ? { signal } : undefined,
          );
          if (res?.ok) {
            const raw = await res.json();
            const data = DLPriceResponseSchema.parse(raw);
            for (const [key, val] of Object.entries(data.coins)) {
              if (val.price > 0) {
                const gId = key.replace("coingecko:", "");
                dlPrices.set(gId, val.price);
              }
            }
            await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, true);
          } else {
            console.warn(`[primary-prices] DL coins API returned ${res?.status ?? "no response"}`);
            await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, false);
          }
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] DL coins API failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, false);
        }
      })(),
    );
  }

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
    const dl = dlPrices.get(gId) ?? null;
    const cg = cgPrices.get(gId) ?? null;
    const pyth = pythPrices.get(asset.id);

    const sources: SourcePrice[] = [];
    if (cg != null) sources.push({ source: "coingecko", price: cg, weight: 2 });
    if (dl != null) sources.push({ source: "defillama", price: dl, weight: 1 });
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
      dlPrice: dl ?? null,
      cgPrice: cg ?? null,
      candidateSources: sources.map((s) => s.source),
      agreeSources: consensus.agreeSources,
    });

    if (consensus.confidence === "high") stats.high++;
    else if (consensus.confidence === "single-source") stats.singleSource++;
    else stats.low++;

    // Track single-source breakdown
    if (consensus.confidence === "single-source") {
      if (consensus.source === "defillama") stats.dlOnly++;
      else if (consensus.source === "coingecko") stats.cgOnly++;
    }

    // Track divergences for observability
    if (consensus.confidence === "low" && dl != null && cg != null) {
      const mid = (dl + cg) / 2;
      const bps = mid > 0 ? Math.round(Math.abs(dl - cg) / mid * 10_000) : 0;
      stats.divergences.push({ id: asset.id, symbol: asset.symbol, dlPrice: dl, cgPrice: cg, bps });
    }
  }

  if (stats.divergences.length > 0) {
    console.warn(
      `[primary-prices] ${stats.divergences.length} price divergences: ` +
      stats.divergences.slice(0, 5).map((d) => `${d.symbol}(${d.bps}bps)`).join(", ") +
      (stats.divergences.length > 5 ? ` ...+${stats.divergences.length - 5} more` : ""),
    );
  }
  console.log(
    `[primary-prices] ${stats.attempted} assets: ${stats.high} high, ${stats.singleSource} single-source, ${stats.low} low confidence`,
  );

  return { results, stats, cgPrices };
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
