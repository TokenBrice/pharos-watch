import { setCacheIfNewer, getCache, getPriceCache, savePriceCache, getOnchainSupply } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import type { StablecoinData } from "../../../src/lib/types";
import { enrichMissingPrices, hasMissingPrice, isReasonablePrice } from "./enrich-prices";
import type { PeggedAsset, DefiLlamaCoinPrice } from "./enrich-prices";
import { detectDepegEvents } from "./detect-depegs";

import { DEFILLAMA_BASE, DEFILLAMA_COINS, DEFILLAMA_API, GECKO_ID_OVERRIDES, USER_AGENT, MIN_VALID_ASSET_COUNT } from "../lib/constants";

interface GoldTokenConfig {
  internalId: string;
  geckoId: string;
  protocolSlug: string;
  name: string;
  symbol: string;
  goldOunces: number; // troy ounces per token (1 for XAUT/PAXG, 1/31.1035 for gram tokens)
}

const GOLD_TOKENS: GoldTokenConfig[] = [
  { internalId: "gold-xaut", geckoId: "tether-gold", protocolSlug: "tether-gold", name: "Tether Gold", symbol: "XAUT", goldOunces: 1 },
  { internalId: "gold-paxg", geckoId: "pax-gold", protocolSlug: "paxos-gold", name: "PAX Gold", symbol: "PAXG", goldOunces: 1 },
  { internalId: "gold-kau", geckoId: "kinesis-gold", protocolSlug: "", name: "Kinesis Gold", symbol: "KAU", goldOunces: 1 / 31.1035 },
  { internalId: "gold-xaum", geckoId: "matrixdock-gold", protocolSlug: "", name: "Matrixdock Gold", symbol: "XAUm", goldOunces: 1 },
  { internalId: "gold-vro", geckoId: "veraone", protocolSlug: "", name: "VeraOne", symbol: "VRO", goldOunces: 1 / 31.1035 },
  { internalId: "gold-cgo", geckoId: "comtech-gold", protocolSlug: "", name: "Comtech Gold", symbol: "CGO", goldOunces: 1 / 31.1035 },
  { internalId: "gold-dgld", geckoId: "gold-token-sa-dgld-tokenized-gold", protocolSlug: "", name: "DGLD Tokenized Gold", symbol: "DGLD", goldOunces: 1 },
];

interface SilverTokenConfig {
  internalId: string;
  geckoId: string;
  name: string;
  symbol: string;
  silverOunces: number; // troy ounces per token
}

const SILVER_TOKENS: SilverTokenConfig[] = [
  { internalId: "silver-kag", geckoId: "kinesis-silver", name: "Kinesis Silver", symbol: "KAG", silverOunces: 1 },
];

async function fetchSilverTokens(): Promise<unknown[]> {
  if (SILVER_TOKENS.length === 0) return [];
  try {
    // Fetch prices from DefiLlama coins API
    const coinIds = SILVER_TOKENS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const priceRes = await fetch(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
    if (!priceRes.ok) {
      console.error(`[silver] Price fetch failed: ${priceRes.status}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Fetch market caps from CoinGecko
    const mcapMap: Record<string, number> = {};
    const ids = SILVER_TOKENS.map((t) => t.geckoId).join(",");
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`,
        { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } }
      );
      if (res.ok) {
        const data = (await res.json()) as Record<string, { usd_market_cap?: number }>;
        for (const t of SILVER_TOKENS) {
          const mcap = data[t.geckoId]?.usd_market_cap;
          if (mcap && mcap > 0) mcapMap[t.internalId] = mcap;
        }
      }
    } catch {
      // CoinGecko fallback failed
    }

    return SILVER_TOKENS
      .map((token) => {
        const priceInfo = priceData.coins[`coingecko:${token.geckoId}`];
        if (!priceInfo) return null;

        const mcap = mcapMap[token.internalId] ?? 0;
        if (!mcap) {
          console.warn(`[silver] No mcap for ${token.symbol}, including with mcap=0`);
        }

        return {
          id: token.internalId,
          name: token.name,
          symbol: token.symbol,
          geckoId: token.geckoId,
          pegType: "peggedSILVER",
          pegMechanism: "rwa-backed",
          price: priceInfo.price,
          priceSource: "defillama",
          circulating: { peggedSILVER: mcap },
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating: {},
          chains: ["Ethereum"],
          goldOunces: token.silverOunces, // reuse field — normalization math is identical
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  } catch (err) {
    console.error("[silver] fetchSilverTokens failed:", err);
    return [];
  }
}

async function fetchGoldTokens(): Promise<unknown[]> {
  try {
    // Fetch prices from DefiLlama coins API
    const coinIds = GOLD_TOKENS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const priceRes = await fetch(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
    if (!priceRes.ok) {
      console.error(`[gold] Price fetch failed: ${priceRes.status}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Fetch market caps + historical TVL from DefiLlama protocol API
    const mcapMap: Record<string, number> = {};
    const tvlHistoryMap: Record<string, { date: number; totalLiquidityUSD: number }[]> = {};
    const protocolFetches = GOLD_TOKENS
      .filter((t) => t.protocolSlug)
      .map(async (t) => {
        try {
          const res = await fetch(`${DEFILLAMA_API}/protocol/${t.protocolSlug}`);
          if (!res.ok) return;
          const data = (await res.json()) as { mcap?: number; tvl?: { date: number; totalLiquidityUSD: number }[] };
          if (data.mcap) mcapMap[t.internalId] = data.mcap;
          if (data.tvl) tvlHistoryMap[t.internalId] = data.tvl;
        } catch {
          // Skip this token
        }
      });
    await Promise.all(protocolFetches);

    // Fallback: fetch mcap from CoinGecko for tokens without a DefiLlama protocol slug
    const noSlugTokens = GOLD_TOKENS.filter((t) => !t.protocolSlug && !mcapMap[t.internalId]);
    if (noSlugTokens.length > 0) {
      const ids = noSlugTokens.map((t) => t.geckoId).join(",");
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`,
          { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } }
        );
        if (res.ok) {
          const data = (await res.json()) as Record<string, { usd_market_cap?: number }>;
          for (const t of noSlugTokens) {
            const mcap = data[t.geckoId]?.usd_market_cap;
            if (mcap && mcap > 0) mcapMap[t.internalId] = mcap;
          }
        }
      } catch {
        // CoinGecko fallback failed — tokens will be skipped
      }
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

    return GOLD_TOKENS
      .map((token) => {
        const priceInfo = priceData.coins[`coingecko:${token.geckoId}`];
        if (!priceInfo) return null;

        // Use protocol mcap if available; if missing, still include token (mcap = 0)
        const mcap = mcapMap[token.internalId] ?? 0;
        if (!mcap) {
          console.warn(`[gold] No mcap for ${token.symbol}, including with mcap=0`);
        }

        const history = tvlHistoryMap[token.internalId];
        const prevDay = history ? findNearestTvl(history, dayAgo) : null;
        const prevWeek = history ? findNearestTvl(history, weekAgo) : null;
        const prevMonth = history ? findNearestTvl(history, monthAgo) : null;

        return {
          id: token.internalId,
          name: token.name,
          symbol: token.symbol,
          geckoId: token.geckoId,
          pegType: "peggedGOLD",
          pegMechanism: "rwa-backed",
          price: priceInfo.price,
          priceSource: "defillama",
          circulating: { peggedGOLD: mcap },
          circulatingPrevDay: prevDay != null ? { peggedGOLD: prevDay } : null,
          circulatingPrevWeek: prevWeek != null ? { peggedGOLD: prevWeek } : null,
          circulatingPrevMonth: prevMonth != null ? { peggedGOLD: prevMonth } : null,
          chainCirculating: {},
          chains: ["Ethereum"],
          goldOunces: token.goldOunces,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  } catch (err) {
    console.error("[gold] fetchGoldTokens failed:", err);
    return [];
  }
}

// Non-DefiLlama fiat stablecoins — fetched from CoinGecko (same pattern as gold tokens)
interface FiatCoinGeckoConfig {
  internalId: string;
  geckoId: string;
  name: string;
  symbol: string;
  pegType: string;   // e.g. "peggedJPY", "peggedIDR"
  pegKey: string;     // key inside circulating object, same as pegType
}

const FIAT_COINGECKO_TOKENS: FiatCoinGeckoConfig[] = [
  { internalId: "cg-jpyc", geckoId: "jpy-coin", name: "JPY Coin", symbol: "JPYC", pegType: "peggedJPY", pegKey: "peggedJPY" },
  { internalId: "cg-idrt", geckoId: "rupiah-token", name: "Rupiah Token", symbol: "IDRT", pegType: "peggedIDR", pegKey: "peggedIDR" },
  { internalId: "cg-eurq", geckoId: "quantoz-eurq", name: "Quantoz EURQ", symbol: "EURQ", pegType: "peggedEUR", pegKey: "peggedEUR" },
  { internalId: "cg-zarp", geckoId: "zarp-stablecoin", name: "ZARP Stablecoin", symbol: "ZARP", pegType: "peggedZAR", pegKey: "peggedZAR" },
  { internalId: "cg-deuro", geckoId: "decentralized-euro", name: "Decentralized Euro", symbol: "DEURO", pegType: "peggedEUR", pegKey: "peggedEUR" },
];

async function fetchFiatCoinGeckoTokens(): Promise<unknown[]> {
  if (FIAT_COINGECKO_TOKENS.length === 0) return [];
  try {
    // Fetch prices from DefiLlama coins API
    const coinIds = FIAT_COINGECKO_TOKENS.map((t) => `coingecko:${t.geckoId}`).join(",");
    const priceRes = await fetch(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
    if (!priceRes.ok) {
      console.error(`[fiat-cg] Price fetch failed: ${priceRes.status}`);
      return [];
    }
    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    // Fetch market caps from CoinGecko
    const mcapMap: Record<string, number> = {};
    const ids = FIAT_COINGECKO_TOKENS.map((t) => t.geckoId).join(",");
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`,
        { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } }
      );
      if (res.ok) {
        const data = (await res.json()) as Record<string, { usd_market_cap?: number }>;
        for (const t of FIAT_COINGECKO_TOKENS) {
          const mcap = data[t.geckoId]?.usd_market_cap;
          if (mcap && mcap > 0) mcapMap[t.internalId] = mcap;
        }
      }
    } catch {
      // CoinGecko fallback failed
    }

    return FIAT_COINGECKO_TOKENS
      .map((token) => {
        const priceInfo = priceData.coins[`coingecko:${token.geckoId}`];
        if (!priceInfo) return null;

        const mcap = mcapMap[token.internalId];
        if (!mcap) {
          console.log(`[fiat-cg] No mcap for ${token.symbol}, skipping`);
          return null;
        }

        return {
          id: token.internalId,
          name: token.name,
          symbol: token.symbol,
          geckoId: token.geckoId,
          pegType: token.pegType,
          pegMechanism: "rwa-backed",
          price: priceInfo.price,
          priceSource: "defillama",
          circulating: { [token.pegKey]: mcap },
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

const SUPPLY_OVERRIDE_COINS: { llamaId: string; geckoId: string; pegKey: string; force?: boolean }[] = [
  { llamaId: "258", geckoId: "a7a5", pegKey: "peggedRUB", force: true }, // DL data unreliable — CG price only, supply from on-chain
];

async function patchSupplyOverrides(assets: PeggedAsset[]): Promise<void> {
  if (SUPPLY_OVERRIDE_COINS.length === 0) return;

  const ids = SUPPLY_OVERRIDE_COINS.map((c) => c.geckoId).join(",");
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`,
      { headers: { Accept: "application/json", "User-Agent": USER_AGENT } }
    );
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, { usd?: number; usd_market_cap?: number }>;

    for (const override of SUPPLY_OVERRIDE_COINS) {
      const asset = assets.find((a) => String(a.id) === override.llamaId);
      const geckoData = data[override.geckoId];
      if (!asset || !geckoData) continue;

      const price = geckoData.usd;
      const mcap = geckoData.usd_market_cap;
      if (!price || price <= 0) continue;

      // Force mode: only override price from CoinGecko, let on-chain override handle supply
      if (override.force) {
        asset.price = price;
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
}

export async function syncStablecoins(db: D1Database): Promise<void> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  const [llamaRes, goldTokens, silverTokens, fiatCgTokens] = await Promise.all([
    fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`),
    fetchGoldTokens(),
    fetchSilverTokens(),
    fetchFiatCoinGeckoTokens(),
  ]);

  if (!llamaRes || !llamaRes.ok) {
    console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
    return;
  }

  const llamaData = await llamaRes.json() as { peggedAssets: PeggedAsset[]; fxFallbackRates?: Record<string, number> };

  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    return;
  }

  // Structural validation: ensure assets have required fields
  const validAssets = llamaData.peggedAssets.filter(
    (a) => a.id != null && typeof a.name === "string" && typeof a.symbol === "string" && a.circulating != null
  );
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    return;
  }
  if (validAssets.length < llamaData.peggedAssets.length) {
    console.warn(`[sync-stablecoins] Dropped ${llamaData.peggedAssets.length - validAssets.length} malformed assets`);
    llamaData.peggedAssets = validAssets;
  }

  if (goldTokens.length || silverTokens.length || fiatCgTokens.length) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...goldTokens as PeggedAsset[], ...silverTokens as PeggedAsset[], ...fiatCgTokens as PeggedAsset[]];
  }

  // Patch corrupted supply data from DefiLlama using CoinGecko
  await patchSupplyOverrides(llamaData.peggedAssets);

  // Patch known missing/wrong geckoIds so enrichMissingPrices can resolve them
  // GECKO_ID_OVERRIDES imported from ../lib/constants
  // Patch known missing contract addresses for Pass 1 resolution
  const ADDRESS_OVERRIDES: Record<string, string> = {
    "213": "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b", // M by M0 — no address in DL stablecoins API
    "67": "arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4", // BEAN — no address in DL stablecoins API
  };
  for (const asset of llamaData.peggedAssets) {
    const geckOverride = GECKO_ID_OVERRIDES[asset.id];
    if (geckOverride && (!asset.geckoId || (asset.geckoId as string).includes("wrong"))) {
      asset.geckoId = geckOverride;
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
  await enrichMissingPrices(llamaData.peggedAssets);

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
      if (cached && (now - cached.updatedAt) < PRICE_CACHE_TTL) {
        asset.price = cached.price;
        fallbackCount++;
      }
    }
    if (fallbackCount > 0) {
      console.log(`[sync-stablecoins] Applied ${fallbackCount} cached fallback prices`);
    }
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
    return;
  }

  // --- On-chain supply override ---
  try {
    const onchainRows = await getOnchainSupply(db, 7200); // 2-hour freshness
    if (onchainRows.length > 0) {
      // Group by stablecoin ID
      const byStablecoin = new Map<string, { chain: string; supply: number }[]>();
      for (const row of onchainRows) {
        const list = byStablecoin.get(row.stablecoin_id) ?? [];
        list.push({ chain: row.chain, supply: row.supply });
        byStablecoin.set(row.stablecoin_id, list);
      }

      let overrideCount = 0;
      for (const [stablecoinId, chainSupplies] of byStablecoin) {
        const asset = llamaData.peggedAssets.find((a) => String(a.id) === stablecoinId);
        if (!asset) continue;

        // Skip override if we don't have on-chain data for ALL configured chains
        // (partial data would produce a wrong, lower total)
        // Exception: force-override coins always use whatever on-chain data we have
        const isForced = SUPPLY_OVERRIDE_COINS.some((c) => c.llamaId === stablecoinId && c.force);
        const meta = TRACKED_META_BY_ID.get(stablecoinId);
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
    return;
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
    await detectDepegEvents(db, llamaData.peggedAssets as unknown as StablecoinData[], llamaData.fxFallbackRates);
  } catch (err) {
    console.error("[sync-stablecoins] Depeg detection failed:", err);
  }
}
