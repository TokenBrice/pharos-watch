import { setCacheIfNewer, getCache, getPriceCache, savePriceCache } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import type { StablecoinData } from "../../../src/lib/types";

const DEFILLAMA_BASE = "https://stablecoins.llama.fi";
const DEFILLAMA_COINS = "https://coins.llama.fi";
const DEFILLAMA_API = "https://api.llama.fi";

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
];

interface DefiLlamaCoinPrice {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
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
          { headers: { "Accept": "application/json", "User-Agent": "stablecoin-dashboard/1.0" } }
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

        // Use protocol mcap if available, otherwise estimate from price
        // For tokens without protocol data, we skip them (no reliable mcap source)
        const mcap = mcapMap[token.internalId];
        if (!mcap) {
          console.log(`[gold] No mcap for ${token.symbol}, skipping`);
          return null;
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

const SUPPLY_OVERRIDE_COINS: { llamaId: string; geckoId: string; pegKey: string }[] = [
  { llamaId: "258", geckoId: "a7a5", pegKey: "peggedRUB" }, // DL supply data corrupted
];

async function patchSupplyOverrides(assets: PeggedAsset[]): Promise<void> {
  if (SUPPLY_OVERRIDE_COINS.length === 0) return;

  const ids = SUPPLY_OVERRIDE_COINS.map((c) => c.geckoId).join(",");
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`,
      { headers: { Accept: "application/json", "User-Agent": "stablecoin-dashboard/1.0" } }
    );
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, { usd?: number; usd_market_cap?: number }>;

    for (const override of SUPPLY_OVERRIDE_COINS) {
      const asset = assets.find((a) => String(a.id) === override.llamaId);
      const geckoData = data[override.geckoId];
      if (!asset || !geckoData) continue;

      const price = geckoData.usd;
      const mcap = geckoData.usd_market_cap;
      if (!price || !mcap || price <= 0) continue;

      // Derive supply in peg currency: mcap / price = circulating tokens (1:1 peg)
      const supplyInPeg = mcap / price;
      const circ = asset.circulating as Record<string, number> | undefined;
      const oldSupply = circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0;

      // Only override if CoinGecko supply is dramatically different (>10x)
      if (oldSupply > 0 && supplyInPeg / oldSupply < 10) continue;

      asset.circulating = { [override.pegKey]: supplyInPeg };
      // Clear historical supply (DL data unreliable) — shows "N/A" for changes
      (asset as Record<string, unknown>).circulatingPrevDay = null;
      (asset as Record<string, unknown>).circulatingPrevWeek = null;
      (asset as Record<string, unknown>).circulatingPrevMonth = null;
      console.log(
        `[sync-stablecoins] Supply override for ${asset.symbol}: ${oldSupply.toFixed(0)} → ${supplyInPeg.toFixed(0)} ${override.pegKey}`
      );
    }
  } catch (err) {
    console.warn("[sync-stablecoins] Supply override fetch failed:", err);
  }
}

interface PeggedAsset {
  id: string;
  name: string;
  symbol: string;
  address?: string;
  geckoId?: string;
  price?: number | null;
  [key: string]: unknown;
}

/**
 * Enrich assets that are missing prices via a 4-pass pipeline:
 *   1. Contract addresses via DefiLlama coins API (with multi-chain fallback)
 *   2. CoinGecko IDs via DefiLlama proxy
 *   3. CoinGecko direct API
 *   4. DexScreener search API (best-effort fallback)
 */
function hasMissingPrice(a: PeggedAsset): boolean {
  return a.price == null || typeof a.price !== "number" || a.price === 0;
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

async function enrichMissingPrices(assets: PeggedAsset[]): Promise<void> {
  const totalMissing = assets.filter(hasMissingPrice).length;
  if (totalMissing === 0) return;

  let pass1Count = 0;
  let pass1bCount = 0;
  let pass2Count = 0;
  let pass3Count = 0;
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
      const coinIds = withAddress.map((m) => m.coinId).join(",");
      const res = await fetch(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
      if (res.ok) {
        const data = (await res.json()) as { coins: Record<string, DefiLlamaCoinPrice> };
        for (const m of withAddress) {
          const priceInfo = data.coins[m.coinId];
          if (priceInfo?.price != null && priceInfo.price > 0) {
            assets[m.index].price = priceInfo.price;
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
        const coinIds = altLookups.map((m) => m.coinId).join(",");
        const res = await fetch(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
        if (res.ok) {
          const data = (await res.json()) as { coins: Record<string, DefiLlamaCoinPrice> };
          const resolved = new Set<number>(); // avoid double-count
          for (const m of altLookups) {
            if (resolved.has(m.index)) continue;
            const priceInfo = data.coins[m.coinId];
            if (priceInfo?.price != null && priceInfo.price > 0) {
              assets[m.index].price = priceInfo.price;
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
      const geckoIds = geckoPass.map((m) => `coingecko:${m.geckoId}`).join(",");
      const geckoRes = await fetch(`${DEFILLAMA_COINS}/prices/current/${geckoIds}`);
      if (geckoRes.ok) {
        const geckoData = (await geckoRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };
        for (const m of geckoPass) {
          const priceInfo = geckoData.coins[`coingecko:${m.geckoId}`];
          if (priceInfo?.price != null && priceInfo.price > 0) {
            assets[m.index].price = priceInfo.price;
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
      const ids = afterPass2.map((m) => m.geckoId).join(",");
      const cgRes = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        { headers: { "Accept": "application/json", "User-Agent": "stablecoin-dashboard/1.0" } }
      );
      if (cgRes.ok) {
        const cgData = (await cgRes.json()) as Record<string, { usd?: number }>;
        for (const m of afterPass2) {
          if (cgData[m.geckoId]?.usd != null) {
            assets[m.index].price = cgData[m.geckoId].usd!;
            pass3Count++;
          }
        }
      } else {
        console.warn(`[enrich] CoinGecko API returned ${cgRes.status}`);
      }
    }

    // ── Pass 4: DexScreener search API (best-effort fallback) ──
    const stillMissing = assets
      .map((a, i) => ({ asset: a, index: i }))
      .filter((m) => hasMissingPrice(m.asset));

    for (const m of stillMissing) {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(m.asset.symbol)}`,
          { headers: { "User-Agent": "stablecoin-dashboard/1.0" } }
        );
        if (!res.ok) {
          console.warn(`[enrich] DexScreener returned ${res.status} for ${m.asset.symbol}`);
          continue;
        }
        const data = (await res.json()) as { pairs?: DexScreenerPair[] };
        if (!data.pairs || data.pairs.length === 0) continue;

        // Filter: matching symbol, has USD price, >$50K liquidity
        const candidates = data.pairs.filter((p) => {
          if (p.baseToken.symbol.toUpperCase() !== m.asset.symbol.toUpperCase()) return false;
          if (!p.priceUsd || !p.liquidity?.usd) return false;
          if (p.liquidity.usd < 50_000) return false;
          return true;
        });

        if (candidates.length === 0) continue;

        // Take price from highest-liquidity pair
        candidates.sort((a, b) => b.liquidity.usd - a.liquidity.usd);
        const price = parseFloat(candidates[0].priceUsd);
        // Sanity check: peg-type-aware range
        const isGold = (m.asset.pegType as string | undefined)?.includes("GOLD");
        const maxPrice = isGold ? 100_000 : 1000;
        if (!isNaN(price) && price > 0.01 && price < maxPrice) {
          assets[m.index].price = price;
          pass4Count++;
        }
      } catch (err) {
        console.warn(`[enrich] DexScreener failed for ${m.asset.symbol}:`, err);
      }
    }

    // ── Summary log ──
    const finalMissing = assets.filter(hasMissingPrice).length;
    const totalEnriched = pass1Count + pass1bCount + pass2Count + pass3Count + pass4Count;
    if (totalMissing > 0) {
      console.log(
        `[enrich] ${totalMissing} assets missing prices → ` +
        `Pass 1: +${pass1Count}, Pass 1b (multi-chain): +${pass1bCount}, ` +
        `Pass 2: +${pass2Count}, Pass 3: +${pass3Count}, ` +
        `Pass 4 (DexScreener): +${pass4Count}, still missing: ${finalMissing}`
      );
    }
    if (totalEnriched > 0) {
      console.log(`[sync-stablecoins] Enriched prices for ${totalEnriched} assets`);
    }
  } catch (err) {
    console.warn("[sync-stablecoins] Price enrichment failed:", err);
  }
}

/** Guard against corrupted API prices that would break peg deviation calculations */
function isReasonablePrice(price: number, pegType: string | undefined): boolean {
  if (!pegType) return price > 0 && price < 100_000;
  if (pegType.includes("USD") || pegType.includes("EUR") || pegType.includes("GBP") || pegType.includes("CHF") || pegType.includes("BRL")) {
    return price > 0.01 && price < 50;
  }
  if (pegType.includes("RUB")) {
    return price > 0.005 && price < 50; // RUB ~$0.0127, lower bound allows for further weakening
  }
  if (pegType.includes("GOLD")) return price > 100 && price < 100_000;
  return price > 0 && price < 100_000;
}

export async function syncStablecoins(db: D1Database): Promise<void> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  const [llamaRes, goldTokens] = await Promise.all([
    fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`),
    fetchGoldTokens(),
  ]);

  if (!llamaRes || !llamaRes.ok) {
    console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
    return;
  }

  const llamaData = await llamaRes.json() as { peggedAssets: PeggedAsset[]; fxFallbackRates?: Record<string, number> };

  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < 50) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), skipping cache write`);
    return;
  }

  // Structural validation: ensure assets have required fields
  const validAssets = llamaData.peggedAssets.filter(
    (a) => a.id != null && typeof a.name === "string" && typeof a.symbol === "string" && a.circulating != null
  );
  if (validAssets.length < 50) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need 50+), skipping cache write`);
    return;
  }
  if (validAssets.length < llamaData.peggedAssets.length) {
    console.warn(`[sync-stablecoins] Dropped ${llamaData.peggedAssets.length - validAssets.length} malformed assets`);
    llamaData.peggedAssets = validAssets;
  }

  if (goldTokens.length) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...goldTokens as PeggedAsset[]];
  }

  // Patch corrupted supply data from DefiLlama using CoinGecko
  await patchSupplyOverrides(llamaData.peggedAssets);

  // Patch known missing/wrong geckoIds so enrichMissingPrices can resolve them
  const GECKO_ID_OVERRIDES: Record<string, string> = {
    "226": "frankencoin",              // ZCHF — DL price intermittently returns 0
    "269": "liquity-bold-2",           // BOLD — no geckoId in DL stablecoins API
    "255": "aegis-yusd",               // YUSD — no geckoId in DL stablecoins API
    "275": "quantoz-usdq",             // USDQ — no geckoId in DL stablecoins API
    "302": "hylo-usd",                 // HYUSD — no geckoId in DL stablecoins API
    "342": "megausd",                  // USDM (MegaUSD) — no geckoId in DL stablecoins API
    "185": "gyroscope-gyd",            // GYD — no geckoId in DL stablecoins API
  };
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

// --- Depeg event detection ---

const DEPEG_THRESHOLD_BPS = 100; // 1%

interface DepegRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  start_price: number;
  peak_price: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string;
}

async function detectDepegEvents(db: D1Database, assets: StablecoinData[], fxFallbackRates?: Record<string, number>): Promise<void> {
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const pegRates = derivePegRates(assets, metaById, fxFallbackRates);
  const now = Math.floor(Date.now() / 1000);

  // Load DEX-implied prices for cross-validation
  // Wrapped in try/catch for resilience if migration 0011 hasn't been applied yet
  let dexPrices = new Map<string, {
    stablecoin_id: string;
    dex_price_usd: number;
    source_pool_count: number;
    source_total_tvl: number;
    updated_at: number;
  }>();
  try {
    const dexPriceResult = await db
      .prepare("SELECT * FROM dex_prices")
      .all<{
        stablecoin_id: string;
        dex_price_usd: number;
        source_pool_count: number;
        source_total_tvl: number;
        updated_at: number;
      }>();
    dexPrices = new Map(
      (dexPriceResult.results ?? []).map((r) => [r.stablecoin_id, r])
    );
  } catch {
    // dex_prices table may not exist yet (pre-migration 0011)
  }

  // Load all open events in one query
  const openResult = await db
    .prepare("SELECT * FROM depeg_events WHERE ended_at IS NULL")
    .all<DepegRow>();

  // Group open events by coin — detect duplicates
  const openByCoin = new Map<string, DepegRow[]>();
  for (const row of openResult.results ?? []) {
    const list = openByCoin.get(row.stablecoin_id) ?? [];
    list.push(row);
    openByCoin.set(row.stablecoin_id, list);
  }

  // Merge duplicate open events: keep earliest, absorb worst peak, delete rest
  const mergeStmts: D1PreparedStatement[] = [];
  const openEvents = new Map<string, DepegRow>();
  for (const [coinId, rows] of openByCoin) {
    if (rows.length === 1) {
      openEvents.set(coinId, rows[0]);
      continue;
    }
    // Sort by started_at ascending — keep the earliest event
    rows.sort((a, b) => a.started_at - b.started_at);
    const keeper = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const dupe = rows[i];
      // Absorb worse peak deviation into the keeper
      if (Math.abs(dupe.peak_deviation_bps) > Math.abs(keeper.peak_deviation_bps)) {
        keeper.peak_deviation_bps = dupe.peak_deviation_bps;
        keeper.peak_price = dupe.peak_price;
      }
      mergeStmts.push(
        db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(dupe.id)
      );
    }
    // Update keeper's peak in DB
    mergeStmts.push(
      db.prepare("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?")
        .bind(keeper.peak_deviation_bps, keeper.peak_price, keeper.id)
    );
    openEvents.set(coinId, keeper);
  }
  if (mergeStmts.length > 0) {
    await db.batch(mergeStmts);
    console.log(`[depeg] Merged duplicate open events, ${mergeStmts.length} DB ops`);
  }

  // Track which open events we've seen (to close orphans)
  const seen = new Set<string>();

  const stmts: D1PreparedStatement[] = [];

  for (const asset of assets) {
    const meta = metaById.get(asset.id);
    if (!meta) continue; // not tracked
    if (meta.flags.navToken) continue; // skip NAV tokens

    const price = asset.price;
    if (price == null || typeof price !== "number" || isNaN(price) || price <= 0) continue;

    const supply = asset.circulating
      ? Object.values(asset.circulating).reduce((s, v) => s + (v ?? 0), 0)
      : 0;
    if (supply < 1_000_000) continue;

    const pegRef = getPegReference(asset.pegType, pegRates, meta.goldOunces);
    if (pegRef <= 0) continue;

    const bps = Math.round(((price / pegRef) - 1) * 10000);
    const absBps = Math.abs(bps);
    const direction = bps >= 0 ? "above" : "below";
    const existing = openEvents.get(asset.id);

    if (absBps >= DEPEG_THRESHOLD_BPS) {
      if (existing) {
        seen.add(asset.id);
        // Direction change: close old event and open a new one
        if (existing.direction !== direction) {
          stmts.push(
            db.prepare(
              "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
            ).bind(now, price, existing.id)
          );
          stmts.push(
            db.prepare(
              `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
            ).bind(asset.id, asset.symbol, asset.pegType ?? "", direction, bps, now, price, price, pegRef)
          );
        } else if (absBps > Math.abs(existing.peak_deviation_bps)) {
          // Same direction — update peak if this deviation is worse
          stmts.push(
            db.prepare(
              "UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?"
            ).bind(bps, price, existing.id)
          );
        }
      } else {
        // Open new event — check DEX price cross-validation first
        const dexRow = dexPrices.get(asset.id);
        const DEX_FRESHNESS_SEC = 1200; // 20 minutes
        const dexFresh = dexRow && (now - dexRow.updated_at) < DEX_FRESHNESS_SEC;
        if (dexFresh) {
          const dexBps = Math.abs(Math.round(
            ((dexRow.dex_price_usd / pegRef) - 1) * 10000
          ));
          if (dexBps < DEPEG_THRESHOLD_BPS) {
            // DEX contradicts primary — likely false positive, suppress opening
            console.log(
              `[depeg] Suppressed new event for ${asset.symbol}: ` +
              `primary=${bps}bps but DEX=${dexBps}bps (${dexRow.source_pool_count} pools, ` +
              `$${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`
            );
            continue;
          }
        }
        stmts.push(
          db.prepare(
            `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
          ).bind(asset.id, asset.symbol, asset.pegType ?? "", direction, bps, now, price, price, pegRef)
        );
        seen.add(asset.id);
      }
    } else if (existing) {
      // Price recovered — close the event
      seen.add(asset.id);
      stmts.push(
        db.prepare(
          "UPDATE depeg_events SET ended_at = ?, recovery_price = ? WHERE id = ?"
        ).bind(now, price, existing.id)
      );
    }
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
    console.log(`[depeg] Wrote ${stmts.length} depeg event updates`);
  }
}
