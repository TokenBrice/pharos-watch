import { DEFILLAMA_COINS, USER_AGENT, DEXSCREENER_MIN_LIQUIDITY_USD, CIRCUIT_SOURCE } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { shouldAttemptFetch, recordOutcome, recordOutcomeSafe } from "../lib/circuit-breaker";
import { getCache, setCache } from "../lib/db-cache";
import { sleepWithSignal, throwIfAborted } from "../lib/abort";
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
import { fetchBinancePrices, fetchCoinbasePrices } from "../lib/cex-tickers";
import { fetchRedstonePrices } from "../lib/redstone";
import { loadDexPriceRows, isTrustedDexPriceRow } from "../lib/depeg-helpers";
import { fetchCurveOnchainPrices } from "../lib/curve-onchain";
import { CURVE_POOL_CONFIGS } from "../lib/curve-pool-configs";
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
}

export function hasMissingPrice(a: PeggedAsset): boolean {
  return a.price == null || typeof a.price !== "number" || a.price === 0;
}

function applyResolvedPrice(
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
}

/** Map DL stablecoins API chain names → DL coins API prefixes */
const CHAIN_PREFIX_MAP: Record<string, string> = {
  "Ethereum": "ethereum",
  "Arbitrum": "arbitrum",
  "Polygon": "polygon",
  "BSC": "bsc",
  "Base": "base",
  "Optimism": "optimism",
  "Avalanche": "avax",
};

/** Build the DL coins API identifier from an asset address */
function addressToCoinId(address: string): string {
  if (address.includes(":")) {
    return address; // already prefixed: "megaeth:0x...", "algorand:..."
  } else if (address.startsWith("0x")) {
    return `ethereum:${address}`;
  } else {
    return `solana:${address}`;
  }
}

interface DexScreenerPair {
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  chainId: string;
}

/**
 * Enrich assets that are missing prices via a 4-pass pipeline:
 *   1. Contract addresses via DefiLlama coins API
 *   1b. Multi-chain contract fallback
 *   2. CoinMarketCap API (rate-limited)
 *   3. DexScreener search API (best-effort)
 */
export interface PrimaryPriceResult {
  price: number;
  source: string;
  confidence: PriceConfidence;
  dlPrice: number | null;
  cgPrice: number | null;
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

  // Symbols for Coinbase/RedStone sequential fetch
  const coinbaseSymbols = [...new Set(candidates.map((a) => a.symbol.toUpperCase()))];

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
            const data = (await res.json()) as { coins: Record<string, { price: number }> };
            for (const [key, val] of Object.entries(data.coins)) {
              if (val?.price != null && val.price > 0) {
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
              cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd`),
              {
                headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }),
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
          await recordOutcome(db, CIRCUIT_SOURCE.PYTH_PRICES, true);
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
          await recordOutcome(db, CIRCUIT_SOURCE.BINANCE_PRICES, true);
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
          await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, true);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] Coinbase ticker failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.COINBASE_PRICES, false);
        }
      })(),
    );
  }

  if (redstoneAllowed) {
    fetches.push(
      (async () => {
        try {
          const prices = await fetchRedstonePrices(coinbaseSymbols, signal);
          for (const [symbol, result] of prices) {
            redstonePrices.set(symbol, {
              price: result.price,
              venueCount: result.venueCount,
              venueAgreementPct: result.venueAgreementPct,
            });
          }
          await recordOutcome(db, CIRCUIT_SOURCE.REDSTONE_PRICES, true);
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
          const prices = await fetchCurveOnchainPrices(CURVE_POOL_CONFIGS, signal);
          for (const [id, price] of prices) curvePrices.set(id, price);
          await recordOutcome(db, CIRCUIT_SOURCE.CURVE_ONCHAIN, true);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[primary-prices] Curve on-chain failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.CURVE_ONCHAIN, false);
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
    const redstoneResult = redstonePrices.get(asset.symbol.toUpperCase());
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
}

const CMC_REQUEST_TIMEOUT_MS = 10_000;
const CMC_MAX_RETRIES = 0;
const DEXSCREENER_MAX_SEARCHES = 10;
const DEXSCREENER_REQUEST_TIMEOUT_MS = 5_000;
const DEXSCREENER_MAX_RETRIES = 0;
const DEXSCREENER_PASS_BUDGET_MS = 45_000;

interface FetchPriceMapByIdsConfig {
  source: string;
  ids: string[];
  buildUrl: (ids: string[]) => string;
  parseResponse: (json: unknown) => Map<string, number>;
  signal?: AbortSignal;
  requestInit?: RequestInit;
  onFetchFailure?: (status: number | null) => void;
}

function parseDefiLlamaPriceMap(json: unknown): Map<string, number> {
  const prices = new Map<string, number>();
  const coins = (json as { coins?: Record<string, DefiLlamaCoinPrice> }).coins ?? {};
  for (const [id, info] of Object.entries(coins)) {
    if (info?.price != null && info.price > 0) {
      prices.set(id, info.price);
    }
  }
  return prices;
}

async function fetchPriceMapByIds(config: FetchPriceMapByIdsConfig): Promise<Map<string, number> | null> {
  if (config.ids.length === 0) return new Map();

  const requestInit: RequestInit = {
    ...(config.requestInit ?? {}),
    ...(config.signal ? { signal: config.signal } : {}),
  };
  const res = await fetchWithRetry(
    config.buildUrl(config.ids),
    Object.keys(requestInit).length > 0 ? requestInit : undefined,
  );
  if (!res?.ok) {
    config.onFetchFailure?.(res?.status ?? null);
    return null;
  }

  try {
    const json = await res.json();
    return config.parseResponse(json);
  } catch {
    console.error(`[enrich-prices] Failed to parse JSON from ${config.source}: ${res.status}`);
    return new Map();
  }
}

export async function enrichMissingPrices(
  assets: PeggedAsset[],
  cmcApiKey?: string,
  db?: D1Database,
  signal?: AbortSignal,
): Promise<EnrichmentStats> {
  throwIfAborted(signal);
  const totalMissing = assets.filter(hasMissingPrice).length;
  if (totalMissing === 0) return { totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passDex: 0, finalMissing: 0 };

  // Load FX rates for dynamic price bounds
  let fxRates: Record<string, number> | undefined;
  if (db) {
    try {
      const fxCache = await getCache(db, "fx-rates");
      if (fxCache) fxRates = JSON.parse(fxCache.value);
    } catch (e) {
      console.warn("[enrich-prices] Failed to load FX rates for price bounds:", e);
    }
  }

  let pass1Count = 0;
  let pass1bCount = 0;
  let passCmcCount = 0;
  let passDexCount = 0;

  try {
    // ── Pass 1: Contract addresses via DefiLlama coins API ──
    const withAddress: { index: number; coinId: string }[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      if (!hasMissingPrice(a) || !a.address) continue;
      withAddress.push({ index: i, coinId: addressToCoinId(a.address) });
    }

    if (withAddress.length > 0) {
      throwIfAborted(signal);
      const pass1Prices = await fetchPriceMapByIds({
        source: "DefiLlama coins API (pass 1)",
        ids: withAddress.map((m) => m.coinId),
        buildUrl: (ids) => `${DEFILLAMA_COINS}/prices/current/${ids.join(",")}`,
        parseResponse: parseDefiLlamaPriceMap,
        signal,
      });
      if (pass1Prices) {
        for (const m of withAddress) {
          const price = pass1Prices.get(m.coinId);
          if (price != null) {
            applyResolvedPrice(assets[m.index], price, "defillama-contract", "single-source");
            pass1Count++;
          }
        }
      }
    }

    // ── Pass 1b: Multi-chain fallback for 0x addresses still missing ──
    const stillMissingAddr = withAddress.filter(
      (m) => hasMissingPrice(assets[m.index]) && m.coinId.startsWith("ethereum:")
    );
    if (stillMissingAddr.length > 0) {
      // Build alternate chain coinIds from the asset's chains field
      const altLookups: { index: number; coinId: string }[] = [];
      for (const m of stillMissingAddr) {
        const a = assets[m.index];
        const chains = a.chains as string[] | undefined;
        if (!chains || !a.address) continue;
        const addr = a.address;
        for (const chain of chains) {
          if (chain === "Ethereum") continue; // already tried
          const prefix = CHAIN_PREFIX_MAP[chain];
          if (prefix) {
            altLookups.push({ index: m.index, coinId: `${prefix}:${addr}` });
          }
        }
      }

      if (altLookups.length > 0) {
        throwIfAborted(signal);
        const pass1bPrices = await fetchPriceMapByIds({
          source: "DefiLlama coins API (pass 1b)",
          ids: altLookups.map((m) => m.coinId),
          buildUrl: (ids) => `${DEFILLAMA_COINS}/prices/current/${ids.join(",")}`,
          parseResponse: parseDefiLlamaPriceMap,
          signal,
        });
        if (pass1bPrices) {
          const resolved = new Set<number>(); // avoid double-count
          for (const m of altLookups) {
            if (resolved.has(m.index)) continue;
            const price = pass1bPrices.get(m.coinId);
            if (price != null) {
              applyResolvedPrice(assets[m.index], price, "defillama-contract", "single-source");
              pass1bCount++;
              resolved.add(m.index);
            }
          }
        }
      }
    }

    // ── Pass 2: CoinMarketCap API (fallback for assets with cmcSlug) ──
    const cmcAllowed =
      cmcApiKey != null && db != null
        ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.CMC_PRICES)
        : true;
    if (cmcApiKey && cmcAllowed) {
      const cmcCandidates = assets
        .map((a, i) => ({ asset: a, index: i }))
        .filter((m) => hasMissingPrice(m.asset) && m.asset.cmcSlug);

      if (cmcCandidates.length > 0) {
        // Rate limit: max 1 CMC call per hour, tracked via cache table
        let shouldCall = true;
        if (db) {
          try {
            const row = await getCache(db, "cmc_last_fetch");
            if (row && (Math.floor(Date.now() / 1000) - row.updatedAt) < 3600) {
              shouldCall = false;
            }
          } catch (e) {
            console.warn("[enrich-prices] CMC rate-limit check failed, proceeding with call:", e);
          }
        }

        if (shouldCall) {
          try {
            const slugs = cmcCandidates.map((m) => m.asset.cmcSlug!).join(",");
            const cmcTimeout = AbortSignal.timeout(CMC_REQUEST_TIMEOUT_MS);
            const cmcSignal = signal ? AbortSignal.any([signal, cmcTimeout]) : cmcTimeout;
            const cmcRes = await fetchWithRetry(
              `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=${slugs}`,
              {
                headers: {
                  "X-CMC_PRO_API_KEY": cmcApiKey,
                  "Accept": "application/json",
                  "User-Agent": USER_AGENT,
                },
                signal: cmcSignal,
              },
              CMC_MAX_RETRIES,
              { timeoutMs: CMC_REQUEST_TIMEOUT_MS },
            );

            if (cmcRes && cmcRes.ok) {
              const cmcData = (await cmcRes.json()) as {
                data: Record<string, {
                  slug: string;
                  quote: { USD: { price: number; market_cap: number } };
                }>;
              };

              // Build slug → CMC entry map (response is keyed by numeric CMC ID)
              const bySlug = new Map<string, { price: number; marketCap: number }>();
              for (const entry of Object.values(cmcData.data)) {
                const usd = entry.quote?.USD;
                if (usd?.price != null) {
                  bySlug.set(entry.slug, { price: usd.price, marketCap: usd.market_cap ?? 0 });
                }
              }

              for (const m of cmcCandidates) {
                const cmcEntry = bySlug.get(m.asset.cmcSlug!);
                if (!cmcEntry) continue;
                if (isReasonablePrice(
                  cmcEntry.price,
                  m.asset.pegType as string | undefined,
                  fxRates,
                  buildPriceReasonablenessOptions(m.asset),
                )) {
                  applyResolvedPrice(assets[m.index], cmcEntry.price, "coinmarketcap", "fallback");
                  passCmcCount++;
                }
              }

              // Update rate-limit timestamp
              if (db) {
                try {
                  await setCache(db, "cmc_last_fetch", "1");
                } catch (e) {
                  console.warn("[enrich-prices] Failed to update CMC rate-limit timestamp:", e);
                }
              }
              if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, true);
            } else {
              console.warn(`[enrich] CMC API returned ${cmcRes?.status ?? "no response"}`);
              if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
            }
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            console.warn("[enrich] CMC API call failed:", err);
            if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.CMC_PRICES, false);
          }
        }
      }
    } else if (cmcApiKey && !cmcAllowed) {
      console.warn("[enrich] CoinMarketCap circuit open — skipping pass 2");
    }

    // ── Pass 3: DexScreener search API (best-effort fallback) ──
    const stillMissing = assets
      .map((a, i) => ({ asset: a, index: i }))
      .filter((m) => hasMissingPrice(m.asset));

    if (stillMissing.length > DEXSCREENER_MAX_SEARCHES) {
      console.warn(`[enrich] ${stillMissing.length} assets still missing prices — capping DexScreener to ${DEXSCREENER_MAX_SEARCHES}`);
    }

    const dexscreenerAllowed =
      db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES) : true;
    let dexAttempts = 0;
    let dexSuccessfulCalls = 0;
    if (dexscreenerAllowed) {
      const dexCandidates = stillMissing.slice(0, DEXSCREENER_MAX_SEARCHES);
      const dexBudgetDeadlineMs = Date.now() + DEXSCREENER_PASS_BUDGET_MS;
      for (const [idx, m] of dexCandidates.entries()) {
        try {
          // DexScreener is the last, best-effort fallback. Keep the whole pass
          // time-bounded so a wave of missing prices cannot exhaust the cron slot.
          if (idx > 0) {
            await sleepWithSignal(200, signal);
          }

          const remainingBudgetMs = dexBudgetDeadlineMs - Date.now();
          if (remainingBudgetMs <= 0) {
            console.warn(
              `[enrich] DexScreener pass budget exhausted after ${dexAttempts}/${dexCandidates.length} searches`,
            );
            break;
          }

          dexAttempts++;
          const timeoutMs = Math.min(DEXSCREENER_REQUEST_TIMEOUT_MS, remainingBudgetMs);
          const res = await fetchWithRetry(
            `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(m.asset.symbol)}`,
            { headers: { "User-Agent": USER_AGENT }, signal },
            DEXSCREENER_MAX_RETRIES,
            { timeoutMs },
          );
          if (!res) {
            console.warn(`[enrich] DexScreener returned no response for ${m.asset.symbol}`);
            continue;
          }
          if (!res.ok) {
            console.warn(`[enrich] DexScreener returned ${res.status} for ${m.asset.symbol}`);
            continue;
          }
          dexSuccessfulCalls++;
          const data = (await res.json()) as { pairs?: DexScreenerPair[] };
          if (!data.pairs || data.pairs.length === 0) continue;

          // Filter: matching symbol, has USD price, >$50K liquidity
          const candidates = data.pairs.filter((p) => {
            if (p.baseToken.symbol.toUpperCase() !== m.asset.symbol.toUpperCase()) return false;
            if (!p.priceUsd || !p.liquidity?.usd) return false;
            if (p.liquidity.usd < DEXSCREENER_MIN_LIQUIDITY_USD) return false;
            return true;
          });

          if (candidates.length === 0) continue;

          // Take price from highest-liquidity pair
          candidates.sort((a, b) => b.liquidity.usd - a.liquidity.usd);
          const price = parseFloat(candidates[0].priceUsd);
          if (isNaN(price) || !isFinite(price) || price <= 0) {
            console.warn(`[enrich] DexScreener returned unparseable price for ${m.asset.symbol}: "${candidates[0].priceUsd}"`);
            continue;
          }
          // Sanity check: peg-type-aware range
          if (isReasonablePrice(
            price,
            m.asset.pegType as string | undefined,
            fxRates,
            buildPriceReasonablenessOptions(m.asset),
          )) {
            applyResolvedPrice(assets[m.index], price, "dexscreener", "fallback");
            passDexCount++;
          }
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn(`[enrich] DexScreener failed for ${m.asset.symbol}:`, err);
        }
      }
      if (dexAttempts > 0) {
        if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES, dexSuccessfulCalls > 0);
      }
    } else if (stillMissing.length > 0) {
      console.warn("[enrich] DexScreener circuit open — skipping pass 3");
    }

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
    return { totalMissing, pass1: pass1Count, pass1b: pass1bCount, passCmc: passCmcCount, passDex: passDexCount, finalMissing };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] Price enrichment failed:", err);
    return { totalMissing, pass1: pass1Count, pass1b: pass1bCount, passCmc: passCmcCount, passDex: passDexCount, finalMissing: totalMissing };
  }
}
