import { DEFILLAMA_COINS, USER_AGENT, DEXSCREENER_MIN_LIQUIDITY_USD, CIRCUIT_SOURCE } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { shouldAttemptFetch, recordOutcome, recordOutcomeSafe } from "../lib/circuit-breaker";
import { getCache, setCache } from "../lib/db";
import { throwIfAborted } from "../lib/abort";
import type { PriceConfidence } from "@shared/types";

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
  cmcSlug?: string;
  navToken?: boolean;
  commodityOunces?: number;
  price?: number | null;
  priceSource?: string;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
  supplySource?: string;
  pegType?: string;
  circulating?: Record<string, number>;
  [key: string]: unknown;
}

export function hasMissingPrice(a: PeggedAsset): boolean {
  return a.price == null || typeof a.price !== "number" || a.price === 0;
}

/** Hardcoded price bounds per peg type — used as fallback when FX rates are unavailable */
export const PRICE_BOUNDS: Record<string, [min: number, max: number]> = {
  USD: [0.01, 1.19],   // USD stablecoins never legitimately trade above $1.19
  EUR: [0.01, 2],
  GBP: [0.01, 2],
  CHF: [0.01, 2],
  BRL: [0.01, 2],
  REAL: [0.01, 2],
  JPY: [0.001, 0.05],
  IDR: [0.00001, 0.001],
  SGD: [0.2, 5],
  TRY: [0.005, 0.5],
  AUD: [0.2, 5],
  RUB: [0.005, 50],
  ZAR: [0.01, 0.5],
  CAD: [0.30, 2],
  CNY: [0.01, 0.50],
  CNH: [0.01, 0.50],
  PHP: [0.002, 0.10],
  MXN: [0.005, 0.20],
  UAH: [0.002, 0.15],
  ARS: [0.000001, 0.05],
  GOLD: [100, 100_000],
  SILVER: [5, 500],
};

export interface PriceReasonablenessOptions {
  navToken?: boolean;
  commodityOunces?: number;
}

function getCommodityPriceScale(
  pegType: string | undefined,
  commodityOunces: number | undefined,
): number {
  if (
    (pegType === "peggedGOLD" || pegType === "peggedSILVER") &&
    typeof commodityOunces === "number" &&
    Number.isFinite(commodityOunces) &&
    commodityOunces > 0
  ) {
    return commodityOunces;
  }
  return 1;
}

export function buildPriceReasonablenessOptions(
  input?: { navToken?: unknown; commodityOunces?: unknown },
): PriceReasonablenessOptions {
  const commodityOunces =
    typeof input?.commodityOunces === "number" &&
    Number.isFinite(input.commodityOunces) &&
    input.commodityOunces > 0
      ? input.commodityOunces
      : undefined;

  return {
    navToken: !!input?.navToken,
    commodityOunces,
  };
}

/** Guard against corrupted API prices that would break peg deviation calculations */
export function isReasonablePrice(
  price: number,
  pegType: string | undefined,
  fxRates?: Record<string, number>,
  opts?: PriceReasonablenessOptions,
): boolean {
  if (!Number.isFinite(price) || price <= 0 || price >= 100_000) return false;

  // NAV tokens (e.g. OUSG, USTB) are USD-denominated but not $1-pegged.
  // They should bypass tight peg bounds while still rejecting absurd values.
  if (opts?.navToken) return true;

  if (!pegType) return true;

  const commodityScale = getCommodityPriceScale(pegType, opts?.commodityOunces);

  // USD is the base currency — no FX rate, keep tight hardcoded bounds
  if (pegType.includes("USD")) {
    const [min, max] = PRICE_BOUNDS.USD;
    return price > min && price < max;
  }

  // Dynamic bounds from live FX rates: 0.01x to 2x
  if (fxRates) {
    const fxRate = fxRates[pegType];
    if (fxRate && fxRate > 0) {
      const scaledFxRate = fxRate * commodityScale;
      return price > 0.01 * scaledFxRate && price < 2 * scaledFxRate;
    }
  }

  // Hardcoded fallback when FX rates unavailable (first boot, cache miss)
  for (const [key, [min, max]] of Object.entries(PRICE_BOUNDS)) {
    if (key === "USD") continue; // Already handled above
    if (pegType.includes(key)) {
      const scale = key === "GOLD" || key === "SILVER" ? commodityScale : 1;
      return price > min * scale && price < max * scale;
    }
  }
  return price > 0 && price < 100_000;
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
 *   1. Contract addresses via DefiLlama coins API (with multi-chain fallback)
 *   2. CoinGecko IDs via DefiLlama proxy
 *   3. CoinGecko direct API
 *   4. DexScreener search API (best-effort fallback)
 */
export interface DualPriceResult {
  price: number;
  source: string;
  confidence: PriceConfidence;
  dlPrice: number | null;
  cgPrice: number | null;
}

export interface DualPriceStats {
  attempted: number;
  high: number;
  singleSource: number;
  low: number;
  divergences: { id: string; symbol: string; dlPrice: number; cgPrice: number; bps: number }[];
}

/**
 * Fetch prices from both DL coins API and CG direct API in parallel,
 * cross-validate within 50bps, and return a confidence-tagged result per asset.
 */
export async function fetchDualPrimaryPrices(
  assets: PeggedAsset[],
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ results: Map<string, DualPriceResult>; stats: DualPriceStats }> {
  throwIfAborted(signal);
  const results = new Map<string, DualPriceResult>();
  const stats: DualPriceStats = { attempted: 0, high: 0, singleSource: 0, low: 0, divergences: [] };

  // Only consider assets with a valid geckoId (no "wrong" tag)
  const candidates = assets.filter(
    (a) => a.geckoId && typeof a.geckoId === "string" && !a.geckoId.includes("wrong"),
  );
  if (candidates.length === 0) return { results, stats };

  const dlAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_COINS);
  const cgAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES);

  if (!dlAllowed && !cgAllowed) {
    console.warn("[dual-primary] Both DL coins and CG prices circuits are open, skipping");
    return { results, stats };
  }

  // Batch fetch both sources in parallel
  const geckoIds = candidates.map((a) => a.geckoId!);
  const BATCH_SIZE = 250; // CG supports 250 IDs per call

  const dlPrices = new Map<string, number>();
  const cgPrices = new Map<string, number>();

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
            console.warn(`[dual-primary] DL coins API returned ${res?.status ?? "no response"}`);
            await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, false);
          }
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[dual-primary] DL coins API failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, false);
        }
      })(),
    );
  }

  if (cgAllowed) {
    fetches.push(
      (async () => {
        try {
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
              console.warn(`[dual-primary] CG price API returned ${res?.status ?? "no response"}`);
            }
          }
          await recordOutcome(db, CIRCUIT_SOURCE.CG_PRICES, true);
        } catch (err) {
          if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          console.warn("[dual-primary] CG price API failed:", err);
          await recordOutcome(db, CIRCUIT_SOURCE.CG_PRICES, false);
        }
      })(),
    );
  }

  await Promise.all(fetches);
  throwIfAborted(signal);

  // Cross-validate per asset
  const DIVERGENCE_THRESHOLD_BPS = 50;

  for (const asset of candidates) {
    const gId = asset.geckoId!;
    const dl = dlPrices.get(gId) ?? null;
    const cg = cgPrices.get(gId) ?? null;
    stats.attempted++;

    if (dl != null && cg != null) {
      const mid = (dl + cg) / 2;
      const divergenceBps = mid > 0 ? Math.abs(dl - cg) / mid * 10_000 : Infinity;

      if (divergenceBps <= DIVERGENCE_THRESHOLD_BPS) {
        // Both agree — high confidence, prefer DL
        results.set(asset.id, { price: dl, source: "defillama+coingecko", confidence: "high", dlPrice: dl, cgPrice: cg });
        stats.high++;
      } else {
        // Disagree — low confidence, use closer-to-peg if true USD peg, else DL
        const pegRef = !asset.navToken && asset.pegType?.includes("USD") ? 1.0 : null;
        const chosen = pegRef != null ? (Math.abs(dl - pegRef) <= Math.abs(cg - pegRef) ? dl : cg) : dl;
        const chosenSource = chosen === dl ? "defillama" : "coingecko";
        results.set(asset.id, { price: chosen, source: chosenSource, confidence: "low", dlPrice: dl, cgPrice: cg });
        stats.low++;
        stats.divergences.push({ id: asset.id, symbol: asset.symbol, dlPrice: dl, cgPrice: cg, bps: Math.round(divergenceBps) });
      }
    } else if (dl != null) {
      results.set(asset.id, { price: dl, source: "defillama", confidence: "single-source", dlPrice: dl, cgPrice: null });
      stats.singleSource++;
    } else if (cg != null) {
      results.set(asset.id, { price: cg, source: "coingecko", confidence: "single-source", dlPrice: null, cgPrice: cg });
      stats.singleSource++;
    }
    // else: both missing — skip, falls through to legacy enrichment
  }

  if (stats.divergences.length > 0) {
    console.warn(
      `[dual-primary] ${stats.divergences.length} price divergences: ` +
      stats.divergences.slice(0, 5).map((d) => `${d.symbol}(${d.bps}bps)`).join(", ") +
      (stats.divergences.length > 5 ? ` ...+${stats.divergences.length - 5} more` : ""),
    );
  }
  console.log(
    `[dual-primary] ${stats.attempted} assets: ${stats.high} high, ${stats.singleSource} single-source, ${stats.low} low confidence`,
  );

  return { results, stats };
}

export interface EnrichmentStats {
  totalMissing: number;
  pass1: number;
  pass1b: number;
  pass2: number;
  pass3: number;
  passCmc: number;
  pass4: number;
  finalMissing: number;
}

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

function parseCoinGeckoUsdMap(json: unknown): Map<string, number> {
  const prices = new Map<string, number>();
  const data = json as Record<string, { usd?: number }>;
  for (const [id, info] of Object.entries(data)) {
    if (info?.usd != null && info.usd > 0) {
      prices.set(id, info.usd);
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
  if (totalMissing === 0) return { totalMissing: 0, pass1: 0, pass1b: 0, pass2: 0, pass3: 0, passCmc: 0, pass4: 0, finalMissing: 0 };

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
  let pass2Count = 0;
  let pass3Count = 0;
  let passCmcCount = 0;
  let pass4Count = 0;

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
            assets[m.index].price = price;
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
              assets[m.index].price = price;
              pass1bCount++;
              resolved.add(m.index);
            }
          }
        }
      }
    }

    // ── Pass 2: CoinGecko IDs via DefiLlama proxy ──
    const geckoPass: { index: number; geckoId: string }[] = [];
    const wrongGeckoPass: { index: number; geckoId: string }[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      if (!hasMissingPrice(a)) continue;
      const geckoId = a.geckoId as string | undefined;
      if (!geckoId) continue;
      if (geckoId.includes("wrong")) {
        // Strip "wrong" suffix to get the real geckoId for Pass 3
        const cleanId = geckoId.replace(/-?wrong-?/g, "").replace(/-$/, "");
        if (cleanId) wrongGeckoPass.push({ index: i, geckoId: cleanId });
      } else {
        geckoPass.push({ index: i, geckoId });
      }
    }

    const afterPass2: { index: number; geckoId: string }[] = [];
    if (geckoPass.length > 0) {
      throwIfAborted(signal);
      const pass2Prices = await fetchPriceMapByIds({
        source: "DefiLlama coins API (pass 2)",
        ids: geckoPass.map((m) => `coingecko:${m.geckoId}`),
        buildUrl: (ids) => `${DEFILLAMA_COINS}/prices/current/${ids.join(",")}`,
        parseResponse: parseDefiLlamaPriceMap,
        signal,
      });
      if (pass2Prices) {
        for (const m of geckoPass) {
          const price = pass2Prices.get(`coingecko:${m.geckoId}`);
          if (price != null) {
            assets[m.index].price = price;
            pass2Count++;
          } else {
            afterPass2.push(m);
          }
        }
      } else {
        afterPass2.push(...geckoPass);
      }
    }
    // "wrong" geckoIds skip Pass 2 but go straight to Pass 3
    afterPass2.push(...wrongGeckoPass);

    // ── Pass 3: CoinGecko direct API ──
    if (afterPass2.length > 0) {
      throwIfAborted(signal);
      const pass3Prices = await fetchPriceMapByIds({
        source: "CoinGecko API (pass 3)",
        ids: afterPass2.map((m) => m.geckoId),
        buildUrl: (ids) => cgUrl(`/simple/price?ids=${ids.join(",")}&vs_currencies=usd`),
        parseResponse: parseCoinGeckoUsdMap,
        signal,
        requestInit: {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }),
        },
        onFetchFailure: (status) => {
          console.warn(`[enrich] CoinGecko API returned ${status ?? "no response"}`);
        },
      });
      if (pass3Prices) {
        for (const m of afterPass2) {
          const price = pass3Prices.get(m.geckoId);
          if (price != null) {
            assets[m.index].price = price;
            pass3Count++;
          }
        }
      }
    }

    // ── Pass 3.5: CoinMarketCap API (fallback for assets with cmcSlug) ──
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
            const cmcTimeout = AbortSignal.timeout(10_000);
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
              }
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
                  assets[m.index].price = cmcEntry.price;
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
      console.warn("[enrich] CoinMarketCap circuit open — skipping pass 3.5");
    }

    // ── Pass 4: DexScreener search API (best-effort fallback) ──
    const stillMissing = assets
      .map((a, i) => ({ asset: a, index: i }))
      .filter((m) => hasMissingPrice(m.asset));

    // Cap at 10 searches — if more are missing, something is fundamentally broken upstream
    const DEXSCREENER_MAX_SEARCHES = 10;
    if (stillMissing.length > DEXSCREENER_MAX_SEARCHES) {
      console.warn(`[enrich] ${stillMissing.length} assets still missing prices — capping DexScreener to ${DEXSCREENER_MAX_SEARCHES}`);
    }

    const dexscreenerAllowed =
      db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES) : true;
    let dexAttempts = 0;
    let dexSuccessfulCalls = 0;
    if (dexscreenerAllowed) {
      for (const m of stillMissing.slice(0, DEXSCREENER_MAX_SEARCHES)) {
        try {
          dexAttempts++;
          // Rate limit: 200ms between DexScreener calls
          if (pass4Count > 0 || stillMissing.indexOf(m) > 0) {
            await new Promise((r) => setTimeout(r, 200));
          }
          const res = await fetchWithRetry(
            `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(m.asset.symbol)}`,
            { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) }
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
            assets[m.index].price = price;
            pass4Count++;
          }
        } catch (err) {
          console.warn(`[enrich] DexScreener failed for ${m.asset.symbol}:`, err);
        }
      }
      if (dexAttempts > 0) {
        if (db) await recordOutcomeSafe(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES, dexSuccessfulCalls > 0);
      }
    } else if (stillMissing.length > 0) {
      console.warn("[enrich] DexScreener circuit open — skipping pass 4");
    }

    // ── Summary log ──
    const finalMissing = assets.filter(hasMissingPrice).length;
    const totalEnriched = pass1Count + pass1bCount + pass2Count + pass3Count + passCmcCount + pass4Count;
    if (totalMissing > 0) {
      console.log(
        `[enrich] ${totalMissing} assets missing prices → ` +
        `Pass 1: +${pass1Count}, Pass 1b (multi-chain): +${pass1bCount}, ` +
        `Pass 2: +${pass2Count}, Pass 3: +${pass3Count}, ` +
        `Pass CMC: +${passCmcCount}, ` +
        `Pass 4 (DexScreener): +${pass4Count}, still missing: ${finalMissing}`
      );
    }
    if (totalEnriched > 0) {
      console.log(`[sync-stablecoins] Enriched prices for ${totalEnriched} assets`);
    }
    return { totalMissing, pass1: pass1Count, pass1b: pass1bCount, pass2: pass2Count, pass3: pass3Count, passCmc: passCmcCount, pass4: pass4Count, finalMissing };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] Price enrichment failed:", err);
    return { totalMissing, pass1: pass1Count, pass1b: pass1bCount, pass2: pass2Count, pass3: pass3Count, passCmc: passCmcCount, pass4: pass4Count, finalMissing: totalMissing };
  }
}

export interface ShadowComparisonResult {
  totalCompared: number;
  meanDivergenceBps: number;
  p95DivergenceBps: number;
  maxDivergenceBps: number;
  coverageLost: number;
  coverageGained: number;
  cgAvailable: boolean;
}

export function computeShadowComparison(
  oldPrices: Map<string, number>,
  newCgPrices: Map<string, number>,
): ShadowComparisonResult {
  const divergences: number[] = [];
  let coverageLost = 0;
  let coverageGained = 0;

  const allIds = new Set([...oldPrices.keys(), ...newCgPrices.keys()]);

  for (const id of allIds) {
    const oldP = oldPrices.get(id);
    const newP = newCgPrices.get(id);

    if (oldP != null && newP != null) {
      const mid = (oldP + newP) / 2;
      if (mid > 0) {
        divergences.push(Math.abs(oldP - newP) / mid * 10_000);
      }
    } else if (oldP != null && newP == null) {
      coverageLost++;
    } else if (oldP == null && newP != null) {
      coverageGained++;
    }
  }

  divergences.sort((a, b) => a - b);
  const mean = divergences.length > 0 ? divergences.reduce((a, b) => a + b, 0) / divergences.length : 0;
  const p95Idx = Math.min(Math.floor(divergences.length * 0.95), divergences.length - 1);
  const p95 = divergences.length > 0 ? divergences[p95Idx] : 0;
  const max = divergences.length > 0 ? divergences[divergences.length - 1] : 0;

  return {
    totalCompared: divergences.length,
    meanDivergenceBps: Math.round(mean * 100) / 100,
    p95DivergenceBps: Math.round(p95 * 100) / 100,
    maxDivergenceBps: Math.round(max * 100) / 100,
    coverageLost,
    coverageGained,
    cgAvailable: newCgPrices.size > 0,
  };
}
