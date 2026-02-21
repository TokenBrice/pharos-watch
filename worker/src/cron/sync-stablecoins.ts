import { setCacheIfNewer, getCache, getPriceCache, savePriceCache, getOnchainSupply } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import { enrichMissingPrices, hasMissingPrice, isReasonablePrice } from "./enrich-prices";
import type { PeggedAsset, DefiLlamaCoinPrice, EnrichmentStats } from "./enrich-prices";
import type { CronResult } from "../lib/db";
import { detectDepegEvents } from "./detect-depegs";

import { DEFILLAMA_BASE, DEFILLAMA_COINS, DEFILLAMA_API, USER_AGENT, MIN_VALID_ASSET_COUNT, SUPPLY_OVERRIDE_COINS, DEX_FRESHNESS_SEC } from "../lib/constants";
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
    ...SUPPLY_OVERRIDE_COINS.map((c) => c.geckoId),
  ].join(",");
  if (!ids) return {};

  const res = await fetchWithRetry(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT } }
  );
  if (!res || !res.ok) {
    console.error(`[sync-stablecoins] CoinGecko batch mcap fetch failed: ${res?.status ?? "no response"}`);
    return {};
  }
  return (await res.json()) as CoinGeckoMcapData;
}

/** Returns CG mcap fallback data for force-override coins (used as safety net after on-chain pass) */
async function patchSupplyOverrides(assets: PeggedAsset[], cgData: CoinGeckoMcapData): Promise<Map<string, { mcap: number; pegKey: string }>> {
  const forcedMcaps = new Map<string, { mcap: number; pegKey: string }>();
  if (SUPPLY_OVERRIDE_COINS.length === 0) return forcedMcaps;

  try {
    for (const override of SUPPLY_OVERRIDE_COINS) {
      const asset = assets.find((a) => String(a.id) === override.llamaId);
      const geckoData = cgData[override.geckoId];
      if (!asset || !geckoData) continue;

      const price = geckoData.usd;
      const mcap = geckoData.usd_market_cap;
      if (!price || price <= 0) continue;

      // Force mode: override price from CoinGecko, stash mcap as fallback for post-on-chain check
      if (override.force) {
        asset.price = price;
        if (mcap && mcap > 0) {
          forcedMcaps.set(override.llamaId, { mcap, pegKey: override.pegKey });
        }
        // Clear DL's historical supply (unreliable for force-override coins)
        // so supply_history fill-in provides correct values
        (asset as Record<string, unknown>).circulatingPrevDay = null;
        (asset as Record<string, unknown>).circulatingPrevWeek = null;
        (asset as Record<string, unknown>).circulatingPrevMonth = null;
        console.log(`[sync-stablecoins] Price-only override for ${asset.symbol}: price $${price.toFixed(6)} (supply deferred to on-chain)`);
        continue;
      }

      if (!mcap) continue;

      // DefiLlama stores circulating values in USD — store mcap directly
      const circ = asset.circulating as Record<string, number> | undefined;
      const oldSupply = circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0;

      // Skip override if DL is close enough
      if (oldSupply > 0 && mcap / oldSupply < 10) continue;

      asset.circulating = { [override.pegKey]: mcap };
      asset.price = price;
      // Clear historical supply (DL data unreliable) — shows "N/A" for changes
      (asset as Record<string, unknown>).circulatingPrevDay = null;
      (asset as Record<string, unknown>).circulatingPrevWeek = null;
      (asset as Record<string, unknown>).circulatingPrevMonth = null;
      console.log(
        `[sync-stablecoins] Supply override for ${asset.symbol}: ${oldSupply.toFixed(0)} → ${mcap.toFixed(0)} USD, price $${price.toFixed(6)}`
      );
    }
  } catch (err) {
    console.warn("[sync-stablecoins] Supply override fetch failed:", err);
  }
  return forcedMcaps;
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

  // Patch corrupted supply data from DefiLlama using CoinGecko
  const forcedMcaps = await patchSupplyOverrides(llamaData.peggedAssets, cgData);

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

  // --- Convert non-USD DefiLlama values from native currency to USD ---
  // DL stores circulating values for non-USD pegs in native denomination
  // (e.g., peggedRUB: 39B means 39B RUB tokens, not $39B USD).
  // Convert to USD by multiplying by the validated price.
  let nativeCurrencyConversions = 0;
  for (const asset of llamaData.peggedAssets) {
    const pegType = (asset.pegType as string) ?? "";
    if (pegType === "peggedUSD" || pegType === "") continue;
    // Only convert DL-sourced assets (numeric IDs); CG/commodity tokens already in USD
    if (!/^\d+$/.test(String(asset.id))) continue;

    const price = typeof asset.price === "number" && asset.price > 0 ? asset.price : null;
    if (!price) continue;

    const circ = asset.circulating as Record<string, number> | undefined;
    if (circ) {
      for (const key of Object.keys(circ)) {
        if (typeof circ[key] === "number" && circ[key] > 0) {
          circ[key] = circ[key] * price;
        }
      }
    }

    for (const field of ["circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"]) {
      const prev = (asset as Record<string, unknown>)[field] as Record<string, number> | undefined;
      if (prev) {
        for (const key of Object.keys(prev)) {
          if (typeof prev[key] === "number" && prev[key] > 0) {
            prev[key] = prev[key] * price;
          }
        }
      }
    }
    nativeCurrencyConversions++;
  }
  if (nativeCurrencyConversions > 0) {
    console.log(`[sync-stablecoins] Converted ${nativeCurrencyConversions} non-USD DL coins from native currency to USD`);
  }

  // --- DEX price cross-validation ---
  let dexOverrides = 0;
  let dexDivergenceWarnings = 0;
  try {
    const dexResult = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, source_pool_count, source_total_tvl, updated_at FROM dex_prices")
      .all<{
        stablecoin_id: string;
        dex_price_usd: number;
        source_pool_count: number;
        source_total_tvl: number;
        updated_at: number;
      }>();
    const dexMap = new Map((dexResult.results ?? []).map((r) => [r.stablecoin_id, r]));
    const nowSec = Math.floor(Date.now() / 1000);
    for (const asset of llamaData.peggedAssets) {
      if (asset.price == null || typeof asset.price !== "number" || asset.price <= 0) continue;
      const dexRow = dexMap.get(String(asset.id));
      if (!dexRow || (nowSec - dexRow.updated_at) >= DEX_FRESHNESS_SEC) continue;

      const divergenceBps = Math.abs(Math.round(((asset.price / dexRow.dex_price_usd) - 1) * 10000));
      if (divergenceBps >= 50) {
        dexDivergenceWarnings++;
        console.warn(
          `[sync-stablecoins] DEX divergence for ${asset.symbol} (id=${asset.id}): ` +
          `primary=$${asset.price} vs DEX=$${dexRow.dex_price_usd} (${divergenceBps}bps, ` +
          `${dexRow.source_pool_count} pools, $${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`
        );
      }
      // Override primary with DEX price at 200bps divergence IF DEX has >= $5M TVL and >= 3 pools
      if (
        divergenceBps >= 200 &&
        dexRow.source_total_tvl >= 5_000_000 &&
        dexRow.source_pool_count >= 3
      ) {
        console.warn(
          `[sync-stablecoins] OVERRIDING primary price for ${asset.symbol}: ` +
          `$${asset.price} → $${dexRow.dex_price_usd} (DEX, ${divergenceBps}bps divergence)`
        );
        asset.price = dexRow.dex_price_usd;
        dexOverrides++;
      }
    }
  } catch (err) {
    console.warn("[sync-stablecoins] DEX cross-validation failed (non-blocking):", err);
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

  // --- CMC supply override: use CMC market cap for coins where DL reports near-zero supply ---
  let cmcSupplyOverrides = 0;
  for (const asset of llamaData.peggedAssets) {
    const cmcMcap = (asset as Record<string, unknown>)._cmcMarketCap as number | undefined;
    if (!cmcMcap || cmcMcap <= 10_000) continue;

    const circ = asset.circulating as Record<string, number> | undefined;
    const dlMcap = circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0;
    if (dlMcap >= 1_000) continue; // DL has meaningful data, skip

    const pegKey = asset.pegType ?? "peggedUSD";
    asset.circulating = { [pegKey]: cmcMcap };
    (asset as Record<string, unknown>).circulatingPrevDay = null;
    (asset as Record<string, unknown>).circulatingPrevWeek = null;
    (asset as Record<string, unknown>).circulatingPrevMonth = null;
    cmcSupplyOverrides++;
    console.log(
      `[sync-stablecoins] CMC supply override for ${asset.symbol} (id=${asset.id}): ` +
      `DL mcap $${dlMcap.toFixed(0)} → CMC mcap $${cmcMcap.toFixed(0)}`
    );
  }
  if (cmcSupplyOverrides > 0) {
    console.log(`[sync-stablecoins] Applied ${cmcSupplyOverrides} CMC supply overrides`);
  }
  // Clean up temp _cmcMarketCap property
  for (const asset of llamaData.peggedAssets) {
    delete (asset as Record<string, unknown>)._cmcMarketCap;
  }

  // Supply sanity check: skip cache write if total supply is implausibly low
  const trackedIds = new Set(TRACKED_STABLECOINS.map((s) => s.id));
  const totalSupply = llamaData.peggedAssets
    .filter((a) => trackedIds.has(a.id))
    .reduce((sum, a) => {
      const circ = a.circulating as Record<string, number> | undefined;
      return sum + (circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0);
    }, 0);
  if (totalSupply < 100_000_000_000) {
    console.error(`[sync-stablecoins] Total supply $${(totalSupply / 1e9).toFixed(1)}B is below $100B floor, skipping cache write`);
    return {};
  }

  // --- On-chain supply override ---
  try {
    const onchainRows = await getOnchainSupply(db, 30 * 24 * 3600); // 30-day window — per-coin freshness checked below
    if (onchainRows.length > 0) {
      // Group by stablecoin ID
      const byStablecoin = new Map<string, { chain: string; supply: number; updated_at: number }[]>();
      for (const row of onchainRows) {
        const list = byStablecoin.get(row.stablecoin_id) ?? [];
        list.push({ chain: row.chain, supply: row.supply, updated_at: row.updated_at });
        byStablecoin.set(row.stablecoin_id, list);
      }

      let overrideCount = 0;
      for (const [stablecoinId, chainSupplies] of byStablecoin) {
        const asset = llamaData.peggedAssets.find((a) => String(a.id) === stablecoinId);
        if (!asset) continue;

        // Only override DL supply for coins that explicitly opt in via supplyMethod
        const meta = TRACKED_META_BY_ID.get(stablecoinId);
        const hasSupplyMethod = meta?.supplyMethod != null && meta.supplyMethod.type !== "exclude";
        const isForced = SUPPLY_OVERRIDE_COINS.some((c) => c.llamaId === stablecoinId && c.force);
        if (!hasSupplyMethod && !isForced) continue;

        // Per-coin freshness: non-forced coins require data within 2 hours;
        // forced coins accept any age (stale on-chain data is still better than broken DL data)
        if (!isForced) {
          const newestAt = Math.max(...chainSupplies.map((cs) => cs.updated_at));
          const age = Math.floor(Date.now() / 1000) - newestAt;
          if (age > 7200) {
            continue; // Stale for regular coins — skip
          }
        }

        if (!isForced && meta?.contracts) {
          const configuredChains = new Set(meta.contracts.map((c) => c.chain));
          const dataChains = new Set(chainSupplies.map((cs) => cs.chain));
          const missing = [...configuredChains].filter((c) => !dataChains.has(c));
          if (missing.length > 0) {
            console.warn(`[sync-stablecoins] Skipping on-chain override for ${asset.symbol}: missing chains ${missing.join(", ")}`);
            continue;
          }
        }

        const onchainTotal = chainSupplies.reduce((s, c) => s + c.supply, 0);
        const price = asset.price as number | null;
        if (!price || price <= 0 || onchainTotal <= 0) continue;

        // Compare on-chain supply (token units) with DefiLlama supply (token units)
        const circ = asset.circulating as Record<string, number> | undefined;
        const llamaMcap = circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0;
        const llamaSupply = llamaMcap / price;

        const divergence = Math.abs(onchainTotal - llamaSupply) / Math.max(llamaSupply, 1);
        if (divergence <= 0.05) continue; // Within 5%, keep DefiLlama

        // Guard: never override if on-chain total is dramatically LOWER than DefiLlama.
        // RPC glitches returning low/partial values are far more likely than DL over-reporting.
        // Exception: force-override coins trust on-chain unconditionally
        if (!isForced && onchainTotal < llamaSupply * 0.5) {
          console.warn(
            `[sync-stablecoins] Rejecting on-chain override for ${asset.symbol}: ` +
            `on-chain ${onchainTotal.toFixed(0)} is <50% of DL ${llamaSupply.toFixed(0)} — likely RPC issue`
          );
          continue;
        }

        // Guard: never override if on-chain total is dramatically HIGHER than DefiLlama.
        // If on-chain is >3x DL, likely includes non-circulating tokens (treasury, pre-minted capacity).
        if (!isForced && llamaSupply > 0 && onchainTotal > llamaSupply * 3) {
          console.warn(
            `[sync-stablecoins] Rejecting on-chain override for ${asset.symbol}: ` +
            `on-chain ${onchainTotal.toFixed(0)} is >3x DL ${llamaSupply.toFixed(0)} — likely includes non-circulating tokens`
          );
          continue;
        }

        // Warning: flag large absolute overrides for monitoring
        const overrideAmountUsd = Math.abs(onchainTotal * (price ?? 0) - llamaMcap);
        if (overrideAmountUsd > 500_000_000) {
          console.warn(
            `[sync-stablecoins] LARGE OVERRIDE for ${asset.symbol}: ` +
            `mcap change $${(overrideAmountUsd / 1e6).toFixed(0)}M — verify data quality`
          );
        }

        // Override: recompute circulating in USD (DefiLlama convention)
        const pegKey = Object.keys(circ ?? {})[0] ?? asset.pegType ?? "peggedUSD";
        const newMcap = onchainTotal * price;
        asset.circulating = { [pegKey]: newMcap };

        // Override chainCirculating with per-chain data
        const chainCirc: Record<string, { current: number; circulatingPrevDay: number; circulatingPrevWeek: number; circulatingPrevMonth: number }> = {};
        for (const cs of chainSupplies) {
          const chainMcap = cs.supply * price;
          chainCirc[cs.chain] = {
            current: chainMcap,
            circulatingPrevDay: 0,
            circulatingPrevWeek: 0,
            circulatingPrevMonth: 0,
          };
        }
        asset.chainCirculating = chainCirc;
        asset.chains = chainSupplies.map((cs) => cs.chain);

        overrideCount++;
        console.log(
          `[sync-stablecoins] On-chain override for ${asset.symbol} (id=${stablecoinId}): ` +
          `DL=${llamaSupply.toFixed(0)} → OnChain=${onchainTotal.toFixed(0)} tokens, mcap $${newMcap.toFixed(0)}`
        );
      }

      if (overrideCount > 0) {
        console.log(`[sync-stablecoins] Applied ${overrideCount} on-chain supply overrides`);
      }
    }
  } catch (err) {
    console.error("[sync-stablecoins] On-chain supply override failed:", err);
  }

  // --- CoinGecko mcap safety net for forced coins ---
  // If on-chain override didn't fire (missing data), fall back to CG mcap
  if (forcedMcaps.size > 0) {
    for (const [llamaId, { mcap, pegKey }] of forcedMcaps) {
      const asset = llamaData.peggedAssets.find((a) => String(a.id) === llamaId);
      if (!asset) continue;

      const circ = asset.circulating as Record<string, number> | undefined;
      const currentMcap = circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0;

      // If current mcap is tiny but CG says it should be large, apply CG mcap
      if (currentMcap < 1000 && mcap > 1_000_000) {
        asset.circulating = { [pegKey]: mcap };
        (asset as Record<string, unknown>).circulatingPrevDay = null;
        (asset as Record<string, unknown>).circulatingPrevWeek = null;
        (asset as Record<string, unknown>).circulatingPrevMonth = null;
        console.log(
          `[sync-stablecoins] CG mcap safety-net for ${asset.symbol} (id=${llamaId}): ` +
          `broken DL mcap $${currentMcap.toFixed(0)} → CG mcap $${mcap.toFixed(0)}`
        );
      }
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

        if (asset.circulatingPrevDay == null && hist.day != null) {
          asset.circulatingPrevDay = { [pegKey]: hist.day };
          fillCount++;
        }
        if (asset.circulatingPrevWeek == null && hist.week != null) {
          asset.circulatingPrevWeek = { [pegKey]: hist.week };
          fillCount++;
        }
        if (asset.circulatingPrevMonth == null && hist.month != null) {
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

  // Post-override sanity check: re-validate total supply after on-chain overrides
  const postOverrideSupply = llamaData.peggedAssets
    .filter((a) => trackedIds.has(a.id))
    .reduce((sum, a) => {
      const circ = a.circulating as Record<string, number> | undefined;
      return sum + (circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0);
    }, 0);
  if (postOverrideSupply < 100_000_000_000) {
    console.error(
      `[sync-stablecoins] Post-override total supply $${(postOverrideSupply / 1e9).toFixed(1)}B ` +
      `is below $100B floor (pre-override was $${(totalSupply / 1e9).toFixed(1)}B), skipping cache write`
    );
    return {};
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
  console.log(`[sync-stablecoins] Cached ${llamaData.peggedAssets.length} assets (total supply: $${(totalSupply / 1e9).toFixed(1)}B)`);

  // Detect depeg events from current price data
  try {
    await detectDepegEvents(db, llamaData.peggedAssets, llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Depeg detection failed:", err);
  }

  // Build metadata for cron_runs observability
  const finalMissing = llamaData.peggedAssets.filter(hasMissingPrice).length;
  const metadata: Record<string, unknown> = {
    assetCount: llamaData.peggedAssets.length,
    totalSupplyB: Math.round(postOverrideSupply / 1e9 * 10) / 10,
    enrichment: enrichStats,
    rejectedPrices: rejectedCount,
    missingPrices: finalMissing,
  };
  if (stalenessWarning) metadata.stalenessWarning = true;
  if (dexOverrides > 0) metadata.dexPriceOverrides = dexOverrides;
  if (dexDivergenceWarnings > 0) metadata.dexDivergenceWarnings = dexDivergenceWarnings;
  if (cmcSupplyOverrides > 0) metadata.cmcSupplyOverrides = cmcSupplyOverrides;

  return { itemCount: llamaData.peggedAssets.length, metadata: JSON.stringify(metadata) };
}
