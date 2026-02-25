import { setCacheIfNewer, getCache, getPriceCache, savePriceCache } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import { enrichMissingPrices, hasMissingPrice, isReasonablePrice } from "./enrich-prices";
import type { PeggedAsset, DefiLlamaCoinPrice, EnrichmentStats } from "./enrich-prices";
import type { CronResult } from "../lib/db";
import { detectDepegEvents } from "./detect-depegs";
import { confirmPendingDepegs } from "./confirm-pending-depegs";

import { DEFILLAMA_BASE, DEFILLAMA_COINS, DEFILLAMA_API, USER_AGENT, MIN_VALID_ASSET_COUNT } from "../lib/constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import type { StablecoinMeta } from "../../../src/lib/types";

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

async function fetchSilverTokens(cgData: CoinGeckoMcapData): Promise<unknown[]> {
  if (SILVER_METAS.length === 0) return [];
  try {
    // Fetch prices from DefiLlama coins API
    const coinIds = SILVER_METAS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const priceRes = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
    if (!priceRes || !priceRes.ok) {
      console.error(`[silver] Price fetch failed: ${priceRes?.status ?? "no response"}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Use pre-fetched CoinGecko market cap data
    const mcapMap: Record<string, number> = {};
    for (const t of SILVER_METAS) {
      const mcap = t.geckoId ? cgData[t.geckoId]?.usd_market_cap : undefined;
      if (mcap && mcap > 0) mcapMap[t.id] = mcap;
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
        } catch {
          // Skip this token
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
        if (!priceInfo) return null;

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
          price: priceInfo.price,
          priceSource: "defillama",
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

export async function syncStablecoins(db: D1Database, cmcApiKey?: string): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  const cgData = await fetchCoinGeckoMarketData();

  const [llamaRes, goldTokens, silverTokens, fiatCgTokens] = await Promise.all([
    fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`),
    fetchGoldTokens(cgData),
    fetchSilverTokens(cgData),
    fetchFiatCoinGeckoTokens(cgData),
  ]);

  if (!llamaRes || !llamaRes.ok) {
    console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
    return {};
  }

  const llamaData = await llamaRes.json() as { peggedAssets: PeggedAsset[]; fxFallbackRates?: Record<string, number> };

  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    return {};
  }

  // Structural validation: ensure assets have required fields
  const validAssets = llamaData.peggedAssets.filter(
    (a) => a.id != null && typeof a.name === "string" && typeof a.symbol === "string" && a.circulating != null
  );
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    return {};
  }
  if (validAssets.length < llamaData.peggedAssets.length) {
    console.warn(`[sync-stablecoins] Dropped ${llamaData.peggedAssets.length - validAssets.length} malformed assets`);
    llamaData.peggedAssets = validAssets;
  }

  if (goldTokens.length || silverTokens.length || fiatCgTokens.length) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...goldTokens as PeggedAsset[], ...silverTokens as PeggedAsset[], ...fiatCgTokens as PeggedAsset[]];
  }

  // Patch known missing/wrong geckoIds from StablecoinMeta so enrichMissingPrices can resolve them
  // Patch known missing contract addresses for Pass 1 resolution
  const ADDRESS_OVERRIDES: Record<string, string> = {
    "213": "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b", // M by M0 — no address in DL stablecoins API
    "67": "arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4", // BEAN — no address in DL stablecoins API
  };
  for (const asset of llamaData.peggedAssets) {
    const meta = TRACKED_META_BY_ID.get(String(asset.id));
    if (meta?.geckoId && (!asset.geckoId || (asset.geckoId as string).includes("wrong"))) {
      asset.geckoId = meta.geckoId;
    }
    if (meta?.cmcSlug && !asset.cmcSlug) {
      asset.cmcSlug = meta.cmcSlug;
    }
    if (!asset.address && ADDRESS_OVERRIDES[asset.id]) {
      asset.address = ADDRESS_OVERRIDES[asset.id];
    }
  }

  // Pre-validate: route unreasonable DefiLlama prices through enrichment
  for (const asset of llamaData.peggedAssets) {
    if (
      asset.price != null &&
      typeof asset.price === "number" &&
      asset.price !== 0 &&
      !isReasonablePrice(asset.price, asset.pegType as string | undefined)
    ) {
      console.warn(`[sync-stablecoins] Pre-rejected bad DL price for ${asset.symbol} (id=${asset.id}): $${asset.price}`);
      asset.price = 0; // hasMissingPrice() treats 0 as missing
    }
  }

  // Enrich any assets that DefiLlama didn't provide prices for
  const missingBefore = new Set(
    llamaData.peggedAssets.filter(hasMissingPrice).map((a) => a.id)
  );
  const enrichStats = await enrichMissingPrices(llamaData.peggedAssets, cmcApiKey, db);

  // --- Reject unreasonable prices BEFORE caching ---
  // Must run before savePriceCache so bad prices don't persist for 24h
  let rejectedCount = 0;
  for (const asset of llamaData.peggedAssets) {
    if (asset.price != null && typeof asset.price === "number" && !isReasonablePrice(asset.price, asset.pegType as string | undefined)) {
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

  // Save: coins that were missing but enrichment resolved (and passed validation)
  const enriched = llamaData.peggedAssets.filter(
    (a) => missingBefore.has(a.id) && !hasMissingPrice(a)
  );
  if (enriched.length > 0) {
    await savePriceCache(db, enriched.map((a) => ({ id: a.id, price: a.price! as number })));
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
      if (cached && (now - cached.updatedAt) < PRICE_CACHE_TTL && isReasonablePrice(cached.price, asset.pegType as string | undefined)) {
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

    if (histRows.results.length > 0) {
      const histMap = new Map<string, { day?: number; week?: number; month?: number }>();
      for (const row of histRows.results) {
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
  } catch {
    // Non-blocking — never prevent cache write
  }

  // Embed live FX fallback rates if available
  const fxCache = await getCache(db, "fx-rates");
  if (fxCache) {
    try {
      llamaData.fxFallbackRates = JSON.parse(fxCache.value);
    } catch { /* ignore malformed cache */ }
  }

  await setCacheIfNewer(db, "stablecoins", JSON.stringify(llamaData), syncStartSec);
  console.log(`[sync-stablecoins] Cached ${llamaData.peggedAssets.length} assets`);

  // Detect depeg events from current price data
  try {
    await detectDepegEvents(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Depeg detection failed:", err);
  }

  // Confirm or expire pending depeg events for >$1B coins
  try {
    await confirmPendingDepegs(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Pending depeg confirmation failed:", err);
  }

  // Build metadata for cron_runs observability
  const finalMissing = llamaData.peggedAssets.filter(hasMissingPrice).length;
  const metadata: Record<string, unknown> = {
    assetCount: llamaData.peggedAssets.length,
    enrichment: enrichStats,
    rejectedPrices: rejectedCount,
    missingPrices: finalMissing,
  };
  if (stalenessWarning) metadata.stalenessWarning = true;

  return { itemCount: llamaData.peggedAssets.length, metadata: JSON.stringify(metadata) };
}
