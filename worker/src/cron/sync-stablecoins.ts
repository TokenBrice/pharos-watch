import { setCacheIfNewer, getCache, getPriceCache, savePriceCache } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import { enrichMissingPrices, hasMissingPrice, isReasonablePrice, fetchDualPrimaryPrices } from "./enrich-prices";
import type { PeggedAsset, DefiLlamaCoinPrice } from "./enrich-prices";
import type { CronResult } from "../lib/db";
import { detectDepegEvents } from "./detect-depegs";
import { confirmPendingDepegs } from "./confirm-pending-depegs";
import { resolveMarketCap } from "../lib/resolve-market-cap";

import { DEFILLAMA_BASE, DEFILLAMA_COINS, DEFILLAMA_API, USER_AGENT, MIN_VALID_ASSET_COUNT, CIRCUIT_SOURCE } from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { StablecoinListResponseSchema, type StablecoinMeta } from "../../../src/lib/types";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { sendAlert } from "../lib/alerts";

// Derive commodity + CG-only fiat token lists from the central registry
const COMMODITY_TOKENS = TRACKED_STABLECOINS.filter(
  (s) => s.flags.pegCurrency === "GOLD" || s.flags.pegCurrency === "SILVER"
);
const GOLD_METAS = TRACKED_STABLECOINS.filter((s) => s.flags.pegCurrency === "GOLD");
const SILVER_METAS = TRACKED_STABLECOINS.filter((s) => s.flags.pegCurrency === "SILVER");
const FIAT_CG_METAS = TRACKED_STABLECOINS.filter((s) => s.id.startsWith("cg-"));

function pegTypeKey(meta: StablecoinMeta): string {
  return `pegged${meta.flags.pegCurrency}`;
}

type StablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

function resolveGeckoId(asset: PeggedAsset): string | undefined {
  if (typeof asset.geckoId === "string" && asset.geckoId.length > 0) {
    return asset.geckoId;
  }
  const snakeCase = asset["gecko_id"];
  if (typeof snakeCase === "string" && snakeCase.length > 0) {
    return snakeCase;
  }
  return undefined;
}

function toPegBuckets(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

function normalizeStablecoinsPayload(payload: StablecoinsPayload): StablecoinsPayload {
  return {
    ...payload,
    peggedAssets: payload.peggedAssets.map((asset) => {
      const { gecko_id: _ignoredSnakeCase, ...rest } = asset as PeggedAsset & { gecko_id?: unknown };
      const confidence = asset.priceConfidence;
      const normalizedConfidence =
        confidence === "high" || confidence === "single-source" || confidence === "low" || confidence === "fallback"
          ? confidence
          : null;

      return {
        ...rest,
        geckoId: resolveGeckoId(asset),
        priceConfidence: normalizedConfidence,
        circulatingPrevDay: toPegBuckets(asset.circulatingPrevDay),
        circulatingPrevWeek: toPegBuckets(asset.circulatingPrevWeek),
        circulatingPrevMonth: toPegBuckets(asset.circulatingPrevMonth),
      };
    }),
  };
}

function hydrateGeckoIdAliases(assets: PeggedAsset[]): void {
  for (const asset of assets) {
    if (typeof asset.geckoId === "string" && asset.geckoId.length > 0) continue;
    const geckoId = resolveGeckoId(asset);
    if (geckoId) asset.geckoId = geckoId;
  }
}

async function fetchSilverTokens(cgData: CoinGeckoMcapData): Promise<unknown[]> {
  if (SILVER_METAS.length === 0) return [];
  try {
    const coinIds = SILVER_METAS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const cgIds = SILVER_METAS.map((t) => t.geckoId).filter(Boolean).join(",");

    // Fetch DL prices + CG circulating_supply in parallel
    const [priceRes, cgMarketsRes] = await Promise.all([
      fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`),
      cgIds
        ? fetchWithRetry(
            cgUrl(`/coins/markets?vs_currency=usd&ids=${cgIds}`),
            { headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }) },
          )
        : Promise.resolve(null),
    ]);

    if (!priceRes || !priceRes.ok) {
      console.error(`[silver] Price fetch failed: ${priceRes?.status ?? "no response"}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Parse circulating_supply per geckoId from CG markets response
    const cgSupplyMap = new Map<string, number>();
    if (cgMarketsRes?.ok) {
      const cgMarketsRaw = await cgMarketsRes.json();
      if (!Array.isArray(cgMarketsRaw)) {
        console.warn("[silver] CG markets returned unexpected shape, falling back to cgData mcap");
      } else {
        const cgMarketsData = cgMarketsRaw as { id: string; circulating_supply?: number }[];
        for (const item of cgMarketsData) {
          if (item.circulating_supply != null && item.circulating_supply > 0) {
            cgSupplyMap.set(item.id, item.circulating_supply);
          }
        }
      }
    } else {
      console.warn(`[silver] CG markets fetch failed (${cgMarketsRes?.status ?? "no response"}), falling back to cgData mcap`);
    }

    // Build mcap map — validate cgData.usd_market_cap against supply×price
    const mcapMap: Record<string, number> = {};
    for (const t of SILVER_METAS) {
      if (!t.geckoId) continue;
      const cgMcap = cgData[t.geckoId]?.usd_market_cap;
      const circulatingSupply = cgSupplyMap.get(t.geckoId);
      const priceInfo = priceData.coins[`coingecko:${t.geckoId}`];
      const price = priceInfo?.price ?? 0;
      const mcap = resolveMarketCap(cgMcap, circulatingSupply, price);
      if (mcap > 0) {
        if (circulatingSupply && cgMcap && Math.abs(cgMcap - mcap) / mcap > 0.01) {
          console.warn(
            `[silver] ${t.symbol}: cgMcap=${cgMcap.toFixed(0)} rejected, using computed=${mcap.toFixed(0)} (supply=${circulatingSupply.toFixed(0)} × price=${price.toFixed(2)})`,
          );
        }
        mcapMap[t.id] = mcap;
      }
    }

    return SILVER_METAS
      .map((meta) => {
        const priceInfo = priceData.coins[`coingecko:${meta.geckoId}`];
        if (!priceInfo) return null;

        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[silver] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        const pKey = pegTypeKey(meta);
        return {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
          geckoId: meta.geckoId,
          pegType: pKey,
          pegMechanism: "rwa-backed",
          price: priceInfo.price,
          priceSource: "defillama",
          circulating: { [pKey]: mcap },
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating: {},
          chains: ["Ethereum"],
          commodityOunces: meta.commodityOunces,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  } catch (err) {
    console.error("[silver] fetchSilverTokens failed:", err);
    return [];
  }
}

async function fetchGoldTokens(cgData: CoinGeckoMcapData): Promise<unknown[]> {
  try {
    // Fetch prices from DefiLlama coins API
    const coinIds = GOLD_METAS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const priceRes = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
    if (!priceRes || !priceRes.ok) {
      console.error(`[gold] Price fetch failed: ${priceRes?.status ?? "no response"}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Fetch market caps + historical TVL from DefiLlama protocol API
    const mcapMap: Record<string, number> = {};
    const tvlHistoryMap: Record<string, { date: number; totalLiquidityUSD: number }[]> = {};
    const protocolFetches = GOLD_METAS
      .filter((t) => t.protocolSlug)
      .map(async (t) => {
        try {
          const res = await fetchWithRetry(`${DEFILLAMA_API}/protocol/${t.protocolSlug}`, { headers: { "User-Agent": USER_AGENT } });
          if (!res) return;
          const data = (await res.json()) as { mcap?: number; tvl?: { date: number; totalLiquidityUSD: number }[] };
          if (data.mcap) mcapMap[t.id] = data.mcap;
          if (data.tvl) tvlHistoryMap[t.id] = data.tvl;
        } catch (e) {
          console.warn(`[sync-stablecoins] Protocol fetch failed for ${t.protocolSlug}:`, e);
        }
      });
    await Promise.all(protocolFetches);

    // Fallback: use pre-fetched CoinGecko data for tokens without a DefiLlama protocol slug
    const noSlugTokens = GOLD_METAS.filter((t) => !t.protocolSlug && !mcapMap[t.id]);
    for (const t of noSlugTokens) {
      const mcap = t.geckoId ? cgData[t.geckoId]?.usd_market_cap : undefined;
      if (mcap && mcap > 0) mcapMap[t.id] = mcap;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const dayAgo = nowSec - 86400;
    const weekAgo = nowSec - 7 * 86400;
    const monthAgo = nowSec - 30 * 86400;

    function findNearestTvl(history: { date: number; totalLiquidityUSD: number }[], targetSec: number): number | null {
      if (!history || history.length === 0) return null;
      let closest: { date: number; totalLiquidityUSD: number } | null = null;
      let closestDist = Infinity;
      for (const point of history) {
        const dist = Math.abs(point.date - targetSec);
        if (dist < closestDist) {
          closestDist = dist;
          closest = point;
        }
      }
      // Only use if within 2 days of target
      return closest && closestDist < 2 * 86400 ? closest.totalLiquidityUSD : null;
    }

    return GOLD_METAS
      .map((meta) => {
        const priceInfo = priceData.coins[`coingecko:${meta.geckoId}`];
        if (!priceInfo) return null;

        // Use protocol mcap if available; if missing, still include token (mcap = 0)
        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[gold] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        // TVL history is only usable when TVL ~ mcap. For some protocols (e.g. Tether Gold)
        // TVL includes multi-chain reserves that far exceed the token's market cap, so using
        // TVL history for supply change % would produce wildly wrong numbers.
        const history = tvlHistoryMap[meta.id];
        let usableHistory: typeof history | undefined = undefined;
        if (history && history.length > 0 && mcap > 0) {
          const latestTvl = history[history.length - 1].totalLiquidityUSD;
          const ratio = mcap / latestTvl;
          if (ratio > 0.85 && ratio < 1.15) {
            usableHistory = history;
          } else {
            console.warn(`[gold] ${meta.symbol}: mcap/tvl divergence (ratio=${ratio.toFixed(3)}), skipping TVL history`);
          }
        }
        const prevDay = usableHistory ? findNearestTvl(usableHistory, dayAgo) : null;
        const prevWeek = usableHistory ? findNearestTvl(usableHistory, weekAgo) : null;
        const prevMonth = usableHistory ? findNearestTvl(usableHistory, monthAgo) : null;

        const pKey = pegTypeKey(meta);
        return {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
          geckoId: meta.geckoId,
          pegType: pKey,
          pegMechanism: "rwa-backed",
          price: priceInfo.price,
          priceSource: "defillama",
          circulating: { [pKey]: mcap },
          circulatingPrevDay: prevDay != null ? { [pKey]: prevDay } : null,
          circulatingPrevWeek: prevWeek != null ? { [pKey]: prevWeek } : null,
          circulatingPrevMonth: prevMonth != null ? { [pKey]: prevMonth } : null,
          chainCirculating: {},
          chains: ["Ethereum"],
          commodityOunces: meta.commodityOunces,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  } catch (err) {
    console.error("[gold] fetchGoldTokens failed:", err);
    return [];
  }
}

async function fetchFiatCoinGeckoTokens(cgData: CoinGeckoMcapData): Promise<unknown[]> {
  if (FIAT_CG_METAS.length === 0) return [];
  try {
    // Fetch prices from DefiLlama coins API
    const coinIds = FIAT_CG_METAS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const priceRes = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
    if (!priceRes || !priceRes.ok) {
      console.error(`[fiat-cg] Price fetch failed: ${priceRes?.status ?? "no response"}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Use pre-fetched CoinGecko market cap data
    const mcapMap: Record<string, number> = {};
    for (const t of FIAT_CG_METAS) {
      const mcap = t.geckoId ? cgData[t.geckoId]?.usd_market_cap : undefined;
      if (mcap && mcap > 0) mcapMap[t.id] = mcap;
    }

    return FIAT_CG_METAS
      .map((meta) => {
        const priceInfo = priceData.coins[`coingecko:${meta.geckoId}`];
        // DefiLlama Coins API may not index every CoinGecko token (e.g. NAV-appreciating
        // tokens like wsrUSD). Fall back to the CoinGecko price already fetched in cgData.
        const price = priceInfo?.price ?? (meta.geckoId ? cgData[meta.geckoId]?.usd : undefined);
        if (price == null) return null;

        const mcap = mcapMap[meta.id];
        if (!mcap) {
          console.log(`[fiat-cg] No mcap for ${meta.symbol}, skipping`);
          return null;
        }

        const pKey = pegTypeKey(meta);
        return {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
          geckoId: meta.geckoId,
          pegType: pKey,
          pegMechanism: meta.flags.backing,
          price,
          priceSource: priceInfo ? "defillama" : "coingecko",
          circulating: { [pKey]: mcap },
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating: {},
          chains: ["Ethereum"],
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  } catch (err) {
    console.error("[fiat-cg] fetchFiatCoinGeckoTokens failed:", err);
    return [];
  }
}

type CoinGeckoMcapData = Record<string, { usd?: number; usd_market_cap?: number }>;

async function fetchCoinGeckoMarketData(): Promise<CoinGeckoMcapData> {
  const ids = [
    ...COMMODITY_TOKENS.filter((t) => !t.protocolSlug).map((t) => t.geckoId).filter(Boolean),
    ...FIAT_CG_METAS.map((t) => t.geckoId).filter(Boolean),
  ].join(",");
  if (!ids) return {};

  const res = await fetchWithRetry(
    cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`),
    { headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }) }
  );
  if (!res || !res.ok) {
    console.error(`[sync-stablecoins] CoinGecko batch mcap fetch failed: ${res?.status ?? "no response"}`);
    return {};
  }
  return (await res.json()) as CoinGeckoMcapData;
}

/**
 * CoinGecko supply fallback: when DefiLlama stablecoins API is down,
 * use CG market cap as a proxy for circulating supply.
 */
async function fallbackToCgSupply(
  db: D1Database,
  cgData: CoinGeckoMcapData,
  cmcApiKey: string | undefined,
  syncStartSec: number,
): Promise<CronResult> {
  console.warn("[sync-stablecoins] Using CoinGecko supply fallback");

  // Build asset list from tracked stablecoins with geckoId
  const assets: PeggedAsset[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.geckoId) continue;
    const mcap = cgData[meta.geckoId]?.usd_market_cap;
    if (!mcap || mcap <= 0) continue;

    const pKey = `pegged${meta.flags.pegCurrency}`;
    const price = cgData[meta.geckoId]?.usd ?? null;

    assets.push({
      id: meta.id,
      name: meta.name,
      symbol: meta.symbol,
      geckoId: meta.geckoId,
      pegType: pKey,
      pegMechanism: meta.flags.backing,
      price,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      supplySource: "coingecko-fallback",
      circulating: { [pKey]: mcap },
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
      chainCirculating: {},
      chains: [],
    });
  }

  if (assets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] CG fallback only got ${assets.length} assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    return {
      metadata: JSON.stringify({
        rowsRead: assets.length,
        rowsWritten: 0,
        rowsDropped: 0,
        sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
        fallbackMode: "coingecko-supply-fallback",
        validationFailures: 1,
      }),
    };
  }

  // Try to restore stale chainCirculating from previous DL cache
  try {
    const prevCache = await getCache(db, "stablecoins");
    if (prevCache) {
      const prevData = JSON.parse(prevCache.value) as { peggedAssets?: PeggedAsset[] };
      if (prevData.peggedAssets) {
        const prevMap = new Map(prevData.peggedAssets.map((a) => [String(a.id), a]));
        for (const asset of assets) {
          const prev = prevMap.get(String(asset.id));
          if (prev?.chainCirculating) {
            asset.chainCirculating = prev.chainCirculating;
            asset.chains = prev.chains ?? [];
          }
          // Restore historical supply if available
          if (prev?.circulatingPrevDay) asset.circulatingPrevDay = prev.circulatingPrevDay;
          if (prev?.circulatingPrevWeek) asset.circulatingPrevWeek = prev.circulatingPrevWeek;
          if (prev?.circulatingPrevMonth) asset.circulatingPrevMonth = prev.circulatingPrevMonth;
        }
      }
    }
  } catch (e) {
    console.warn("[sync-stablecoins] Failed to restore stale cache data:", e);
  }

  // Enrich missing prices
  const enrichStats = await enrichMissingPrices(assets, cmcApiKey, db);

  // Embed FX rates
  const fxCache = await getCache(db, "fx-rates");
  let fxFallbackRates: Record<string, number> | undefined;
  if (fxCache) {
    try {
      fxFallbackRates = JSON.parse(fxCache.value);
    } catch { /* ignore */ }
  }

  const llamaData: StablecoinsPayload = { peggedAssets: assets, fxFallbackRates };
  const normalizedPayload = normalizeStablecoinsPayload(llamaData);
  const validation = validatePayloadWithSchema(
    StablecoinListResponseSchema,
    normalizedPayload,
    "sync-stablecoins:stablecoins:fallback",
  );
  if (!validation.ok) {
    console.error("[sync-stablecoins] Schema validation failed in CG fallback; writing guarded normalized payload:", validation.issues);
    await sendAlert(
      "Stablecoins schema validation warning",
      `CG fallback payload failed schema validation; writing guarded fallback. issues=${validation.issues.slice(0, 400)}`,
    );
    await setCacheIfNewer(db, "stablecoins", JSON.stringify(normalizedPayload), syncStartSec);
    return {
      itemCount: assets.length,
      metadata: JSON.stringify({
        rowsRead: assets.length,
        rowsWritten: assets.length,
        rowsDropped: 0,
        sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
        fallbackMode: "coingecko-supply-fallback",
        validationFailures: 1,
        cacheWriteMode: "schema-validation-fallback",
      }),
    };
  }
  await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  console.log(`[sync-stablecoins] CG fallback: cached ${assets.length} assets`);

  // Still run depeg detection
  try {
    await detectDepegEvents(db, assets, fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Depeg detection failed (CG fallback):", err);
  }

  return {
    itemCount: assets.length,
    metadata: JSON.stringify({
      rowsRead: assets.length,
      rowsWritten: assets.length,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: assets.length },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 0,
      enrichment: enrichStats,
    }),
  };
}

export async function syncStablecoins(db: D1Database, cmcApiKey?: string, signal?: AbortSignal): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  const cgData = await fetchCoinGeckoMarketData();

  // Check circuit breaker before DL fetch
  const dlAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_STABLECOINS);

  const [llamaRes, goldTokens, silverTokens, fiatCgTokens] = await Promise.all([
    dlAllowed
      ? fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`, signal ? { signal } : undefined)
      : Promise.resolve(null),
    fetchGoldTokens(cgData),
    fetchSilverTokens(cgData),
    fetchFiatCoinGeckoTokens(cgData),
  ]);

  // Record DL outcome and fallback if needed
  if (dlAllowed) {
    if (!llamaRes?.ok) {
      console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
      const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
      if (fallback.itemCount && fallback.itemCount > 0) return fallback;
      throw new Error("DefiLlama stablecoins API failed and CoinGecko fallback was insufficient");
    }
  } else {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error("DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient");
  }

  const llamaData = await llamaRes!.json() as { peggedAssets: PeggedAsset[]; fxFallbackRates?: Record<string, number> };
  const rawAssetCount = llamaData.peggedAssets?.length ?? 0;

  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error(
      `DefiLlama payload was structurally invalid (asset count=${llamaData.peggedAssets?.length ?? 0}) and fallback failed`,
    );
  }

  // Structural validation: ensure assets have required fields
  const validAssets = llamaData.peggedAssets.filter(
    (a) => a.id != null && typeof a.name === "string" && typeof a.symbol === "string" && a.circulating != null
  );
  const droppedMalformedAssets = rawAssetCount - validAssets.length;
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    const fallback = await fallbackToCgSupply(db, cgData, cmcApiKey, syncStartSec);
    if (fallback.itemCount && fallback.itemCount > 0) return fallback;
    throw new Error(
      `DefiLlama payload had too many malformed assets (valid=${validAssets.length}) and fallback failed`,
    );
  }
  if (validAssets.length < llamaData.peggedAssets.length) {
    console.warn(`[sync-stablecoins] Dropped ${llamaData.peggedAssets.length - validAssets.length} malformed assets`);
    llamaData.peggedAssets = validAssets;
  }

  // DefiLlama may emit `gecko_id` (snake_case). Hydrate `geckoId` early so
  // dual-primary and enrichment passes can still use CoinGecko identifiers.
  hydrateGeckoIdAliases(llamaData.peggedAssets);

  // Normalize chainCirculating: DL returns peg-bucket objects ({peggedUSD: N})
  // for current/prev values — flatten to plain numbers so the frontend schema
  // and components can consume them directly.
  const CC_KEYS = ["current", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"];
  for (const asset of llamaData.peggedAssets) {
    const cc = asset.chainCirculating as Record<string, Record<string, unknown>> | undefined;
    if (!cc || typeof cc !== "object") continue;
    for (const chain of Object.keys(cc)) {
      const entry = cc[chain];
      if (!entry || typeof entry !== "object") continue;
      for (const key of CC_KEYS) {
        const val = entry[key];
        if (val && typeof val === "object") {
          entry[key] = Object.values(val as Record<string, number>)
            .reduce((s: number, v: number) => s + (Number.isFinite(v) ? v : 0), 0);
        }
      }
    }
  }

  if (goldTokens.length || silverTokens.length || fiatCgTokens.length) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...goldTokens as PeggedAsset[], ...silverTokens as PeggedAsset[], ...fiatCgTokens as PeggedAsset[]];
  }

  // Always prefer our curated geckoId/cmcSlug over DefiLlama's — DL can have
  // stale or wrong IDs (e.g. BOLD: DL returns "liquity-bold" which is Legacy BOLD,
  // a different token; ours is "liquity-bold-2", the real Liquity v2 BOLD).
  // Patch known missing contract addresses for Pass 1 resolution.
  const ADDRESS_OVERRIDES: Record<string, string> = {
    "213": "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b", // M by M0 — no address in DL stablecoins API
    "67": "arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4", // BEAN — no address in DL stablecoins API
  };
  for (const asset of llamaData.peggedAssets) {
    const meta = TRACKED_META_BY_ID.get(String(asset.id));
    if (meta?.geckoId) {
      asset.geckoId = meta.geckoId;
    }
    if (meta?.cmcSlug) {
      asset.cmcSlug = meta.cmcSlug;
    }
    if (!asset.address && ADDRESS_OVERRIDES[asset.id]) {
      asset.address = ADDRESS_OVERRIDES[asset.id];
    }
  }

  // Load FX rates early for dynamic price bounds in isReasonablePrice
  let fxRates: Record<string, number> | undefined;
  const fxCacheEarly = await getCache(db, "fx-rates");
  const maxFxAgeSec = 6 * 3600;
  if (fxCacheEarly) {
    const fxAgeSec = Math.floor(Date.now() / 1000) - fxCacheEarly.updatedAt;
    if (fxAgeSec <= maxFxAgeSec) {
      try { fxRates = JSON.parse(fxCacheEarly.value); } catch { /* ignore */ }
    } else {
      console.warn(`[sync-stablecoins] Ignoring stale FX cache (${fxAgeSec}s old)`);
    }
  }

  // --- Dual-primary price validation ---
  // Cross-validate DL coins API and CG prices for higher confidence
  const { results: dualPriceResults, stats: dualPriceStats } = await fetchDualPrimaryPrices(
    llamaData.peggedAssets, db,
  );

  // Apply dual-primary results — these override the DL list endpoint prices
  for (const asset of llamaData.peggedAssets) {
    const dual = dualPriceResults.get(asset.id);
    if (dual && isReasonablePrice(dual.price, asset.pegType as string | undefined, fxRates)) {
      asset.price = dual.price;
      asset.priceSource = dual.source;
      asset.priceConfidence = dual.confidence;
    } else if (asset.price != null && typeof asset.price === "number" && asset.price > 0) {
      // DL list provided a price but no dual-primary result — single-source
      asset.priceSource = asset.priceSource || "defillama";
      asset.priceConfidence = "single-source";
    }
  }

  // Tag all DL-sourced assets with supplySource
  for (const asset of llamaData.peggedAssets) {
    if (!asset.supplySource) {
      asset.supplySource = "defillama";
    }
  }

  // Pre-validate: route unreasonable prices through enrichment
  for (const asset of llamaData.peggedAssets) {
    if (
      asset.price != null &&
      typeof asset.price === "number" &&
      asset.price !== 0 &&
      !isReasonablePrice(asset.price, asset.pegType as string | undefined, fxRates)
    ) {
      console.warn(`[sync-stablecoins] Pre-rejected bad price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
      asset.price = 0; // hasMissingPrice() treats 0 as missing
      asset.priceConfidence = null;
    }
  }

  // Enrich any assets that still have missing prices
  const missingBefore = new Set(
    llamaData.peggedAssets.filter(hasMissingPrice).map((a) => a.id)
  );
  const enrichStats = await enrichMissingPrices(llamaData.peggedAssets, cmcApiKey, db);

  // Tag enriched assets with fallback confidence
  for (const asset of llamaData.peggedAssets) {
    if (missingBefore.has(asset.id) && !hasMissingPrice(asset) && !asset.priceConfidence) {
      asset.priceConfidence = "fallback";
    }
  }

  // --- Reject unreasonable prices BEFORE caching ---
  // Must run before savePriceCache so bad prices don't persist for 24h
  let rejectedCount = 0;
  for (const asset of llamaData.peggedAssets) {
    if (asset.price != null && typeof asset.price === "number" && !isReasonablePrice(asset.price, asset.pegType as string | undefined, fxRates)) {
      console.warn(`[sync-stablecoins] Rejected unreasonable price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
      asset.price = null;
      rejectedCount++;
    }
  }
  if (rejectedCount > 0) {
    console.log(`[sync-stablecoins] Rejected ${rejectedCount} unreasonable prices`);
  }

  // --- Price cache: save successes, apply fallbacks ---
  const PRICE_CACHE_TTL = 24 * 60 * 60; // 24 hours
  const now = Math.floor(Date.now() / 1000);

  // Save ALL assets with valid prices so other crons (mint-burn sync) can look them up.
  // Previously only enriched assets were cached, starving mint-burn of price data.
  const withValidPrices = llamaData.peggedAssets.filter(
    (a) => a.price != null && typeof a.price === "number" && a.price > 0
  );
  if (withValidPrices.length > 0) {
    await savePriceCache(db, withValidPrices.map((a) => ({ id: a.id, price: a.price! as number })));
  }

  // Fallback: coins still missing — apply cached price if within TTL
  const stillMissing = llamaData.peggedAssets.filter(
    (a) => missingBefore.has(a.id) && hasMissingPrice(a)
  );
  if (stillMissing.length > 0) {
    const priceCache = await getPriceCache(db);
    let fallbackCount = 0;
    for (const asset of stillMissing) {
      const cached = priceCache.get(asset.id);
      if (cached && (now - cached.updatedAt) < PRICE_CACHE_TTL && isReasonablePrice(cached.price, asset.pegType as string | undefined, fxRates)) {
        asset.price = cached.price;
        fallbackCount++;
      }
    }
    if (fallbackCount > 0) {
      console.log(`[sync-stablecoins] Applied ${fallbackCount} cached fallback prices`);
    }
  }

  // --- Fill missing circulatingPrev* from supply_history snapshots ---
  try {
    const nowMs = Date.now();
    const utcMidnight = (daysAgo: number) => {
      const d = new Date(nowMs);
      d.setUTCDate(d.getUTCDate() - daysAgo);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
    };
    const date1d = utcMidnight(1);
    const date7d = utcMidnight(7);
    const date30d = utcMidnight(30);

    const histRows = await db
      .prepare(
        "SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE snapshot_date IN (?, ?, ?)"
      )
      .bind(date1d, date7d, date30d)
      .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();

    if ((histRows.results ?? []).length > 0) {
      const histMap = new Map<string, { day?: number; week?: number; month?: number }>();
      for (const row of histRows.results ?? []) {
        const entry = histMap.get(row.stablecoin_id) ?? {};
        if (row.snapshot_date === date1d) entry.day = row.circulating_usd;
        else if (row.snapshot_date === date7d) entry.week = row.circulating_usd;
        else if (row.snapshot_date === date30d) entry.month = row.circulating_usd;
        histMap.set(row.stablecoin_id, entry);
      }

      let fillCount = 0;
      for (const asset of llamaData.peggedAssets) {
        const hist = histMap.get(String(asset.id));
        if (!hist) continue;

        const circ = asset.circulating as Record<string, number> | undefined;
        if (!circ) continue;
        const pegKey = Object.keys(circ)[0];
        if (!pegKey) continue;
        const currentVal = circ[pegKey] ?? 0;

        // Guard: skip historical values that diverge >30% from current circulating.
        // Catches bad data (e.g. TVL-based backfill for tokens where TVL ≠ mcap).
        const isReasonable = (v: number) =>
          currentVal > 0 && Math.abs(v - currentVal) / currentVal <= 0.30;

        if (asset.circulatingPrevDay == null && hist.day != null && isReasonable(hist.day)) {
          asset.circulatingPrevDay = { [pegKey]: hist.day };
          fillCount++;
        }
        if (asset.circulatingPrevWeek == null && hist.week != null && isReasonable(hist.week)) {
          asset.circulatingPrevWeek = { [pegKey]: hist.week };
          fillCount++;
        }
        if (asset.circulatingPrevMonth == null && hist.month != null && isReasonable(hist.month)) {
          asset.circulatingPrevMonth = { [pegKey]: hist.month };
          fillCount++;
        }
      }

      if (fillCount > 0) {
        console.log(`[sync-stablecoins] Filled ${fillCount} missing supply changes from supply_history`);
      }
    }
  } catch (err) {
    console.warn("[sync-stablecoins] supply_history fallback failed:", err);
  }

  // --- Staleness detection: compare prices against previous cache ---
  let stalenessWarning = false;
  try {
    const prevCache = await getCache(db, "stablecoins");
    if (prevCache) {
      const prevData = JSON.parse(prevCache.value) as { peggedAssets?: PeggedAsset[] };
      if (prevData.peggedAssets) {
        const prevPrices = new Map(
          prevData.peggedAssets
            .filter((a) => a.price != null && typeof a.price === "number" && a.price > 0)
            .map((a) => [a.id, a.price as number])
        );
        let identical = 0;
        let compared = 0;
        for (const asset of llamaData.peggedAssets) {
          const prevPrice = prevPrices.get(asset.id);
          if (prevPrice == null || asset.price == null || typeof asset.price !== "number" || asset.price <= 0) continue;
          compared++;
          if (Math.abs(asset.price - prevPrice) / prevPrice < 0.0001) {
            identical++;
          }
        }
        if (compared >= 50 && identical / compared > 0.95) {
          stalenessWarning = true;
          console.warn(
            `[sync-stablecoins] STALENESS WARNING: ${identical}/${compared} prices ` +
            `(${(identical / compared * 100).toFixed(1)}%) are identical to previous cache — possible upstream stale data`
          );
        }
      }
    }
  } catch (e) {
    console.warn("[sync-stablecoins] Staleness check failed:", e);
  }

  // Embed live FX fallback rates if available (reuse earlier fetch)
  if (fxRates) {
    llamaData.fxFallbackRates = fxRates;
  }

  const normalizedPayload = normalizeStablecoinsPayload(llamaData);
  const validation = validatePayloadWithSchema(
    StablecoinListResponseSchema,
    normalizedPayload,
    "sync-stablecoins:stablecoins",
  );
  if (!validation.ok) {
    console.error("[sync-stablecoins] Schema validation failed; writing guarded normalized payload:", validation.issues);
    await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    await sendAlert(
      "Stablecoins schema validation warning",
      `Payload failed schema validation; writing guarded fallback. issues=${validation.issues.slice(0, 400)}`,
    );
    await setCacheIfNewer(db, "stablecoins", JSON.stringify(normalizedPayload), syncStartSec);
    return {
      itemCount: llamaData.peggedAssets.length,
      metadata: JSON.stringify({
        rowsRead: rawAssetCount,
        rowsWritten: llamaData.peggedAssets.length,
        rowsDropped: droppedMalformedAssets,
        sourceCoverage: { defillama: true },
        fallbackMode: "schema-validation-fallback",
        validationFailures: 1,
        cacheWriteMode: "schema-validation-fallback",
      }),
    };
  }

  await setCacheIfNewer(db, "stablecoins", JSON.stringify(validation.data), syncStartSec);
  await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, true);
  console.log(`[sync-stablecoins] Cached ${llamaData.peggedAssets.length} assets`);

  // Detect depeg events from current price data
  const depegErrors: string[] = [];
  try {
    await detectDepegEvents(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Depeg detection failed:", err);
    depegErrors.push(`detection: ${String(err).slice(0, 200)}`);
  }

  // Confirm or expire pending depeg events for >$1B coins
  try {
    await confirmPendingDepegs(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Pending depeg confirmation failed:", err);
    depegErrors.push(`confirmation: ${String(err).slice(0, 200)}`);
  }

  // Build metadata for cron_runs observability
  const finalMissing = llamaData.peggedAssets.filter(hasMissingPrice).length;
  const metadata: Record<string, unknown> = {
    rowsRead: rawAssetCount,
    rowsWritten: llamaData.peggedAssets.length,
    rowsDropped: droppedMalformedAssets,
    sourceCoverage: { defillama: true },
    fallbackMode: null,
    validationFailures: 0,
    assetCount: llamaData.peggedAssets.length,
    enrichment: enrichStats,
    dualPrimary: dualPriceStats,
    rejectedPrices: rejectedCount,
    missingPrices: finalMissing,
  };
  if (stalenessWarning) metadata.stalenessWarning = true;
  if (depegErrors.length > 0) metadata.depegErrors = depegErrors;

  return { itemCount: llamaData.peggedAssets.length, metadata: JSON.stringify(metadata) };
}
