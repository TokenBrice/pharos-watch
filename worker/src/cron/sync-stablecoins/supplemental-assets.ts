import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { StablecoinMeta } from "@shared/types";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../../lib/constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { resolveMarketCap } from "../../lib/resolve-market-cap";
import type { DefiLlamaCoinPrice, PeggedAsset } from "../enrich-prices";

const COMMODITY_TOKENS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.flags.pegCurrency === "GOLD" || stablecoin.flags.pegCurrency === "SILVER",
);

const GOLD_METAS = TRACKED_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "GOLD");
const SILVER_METAS = TRACKED_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "SILVER");
const FIAT_CG_METAS = TRACKED_STABLECOINS.filter((stablecoin) => stablecoin.detailProvider === "coingecko");

function pegTypeKey(meta: StablecoinMeta): string {
  return `pegged${meta.flags.pegCurrency}`;
}

export type CoinGeckoMcapData = Record<string, { usd?: number; usd_market_cap?: number }>;

async function fetchSilverTokens(cgData: CoinGeckoMcapData): Promise<PeggedAsset[]> {
  if (SILVER_METAS.length === 0) return [];

  try {
    const coinIds = SILVER_METAS.map((token) => `coingecko:${token.geckoId}`).join(",");
    const cgIds = SILVER_METAS.map((token) => token.geckoId).filter(Boolean).join(",");

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

    const mcapMap: Record<string, number> = {};
    for (const token of SILVER_METAS) {
      if (!token.geckoId) continue;
      const cgMcap = cgData[token.geckoId]?.usd_market_cap;
      const circulatingSupply = cgSupplyMap.get(token.geckoId);
      const priceInfo = priceData.coins[`coingecko:${token.geckoId}`];
      const price = priceInfo?.price ?? 0;
      const mcap = resolveMarketCap(cgMcap, circulatingSupply, price);

      if (mcap > 0) {
        if (circulatingSupply && cgMcap && Math.abs(cgMcap - mcap) / mcap > 0.01) {
          console.warn(
            `[silver] ${token.symbol}: cgMcap=${cgMcap.toFixed(0)} rejected, using computed=${mcap.toFixed(0)} (supply=${circulatingSupply.toFixed(0)} × price=${price.toFixed(2)})`,
          );
        }
        mcapMap[token.id] = mcap;
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
        } as PeggedAsset;
      })
      .filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    console.error("[silver] fetchSilverTokens failed:", err);
    return [];
  }
}

async function fetchGoldTokens(cgData: CoinGeckoMcapData): Promise<PeggedAsset[]> {
  try {
    const coinIds = GOLD_METAS.map((token) => `coingecko:${token.geckoId}`).join(",");
    const priceRes = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);

    if (!priceRes || !priceRes.ok) {
      console.error(`[gold] Price fetch failed: ${priceRes?.status ?? "no response"}`);
      return [];
    }

    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    const mcapMap: Record<string, number> = {};
    const tvlHistoryMap: Record<string, { date: number; totalLiquidityUSD: number }[]> = {};
    const protocolFetches = GOLD_METAS
      .filter((token) => token.protocolSlug)
      .map(async (token) => {
        try {
          const res = await fetchWithRetry(`${DEFILLAMA_API}/protocol/${token.protocolSlug}`, {
            headers: { "User-Agent": USER_AGENT },
          });
          if (!res) return;

          const data = (await res.json()) as { mcap?: number; tvl?: { date: number; totalLiquidityUSD: number }[] };
          if (data.mcap) mcapMap[token.id] = data.mcap;
          if (data.tvl) tvlHistoryMap[token.id] = data.tvl;
        } catch (err) {
          console.warn(`[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}:`, err);
        }
      });
    await Promise.all(protocolFetches);

    const noSlugTokens = GOLD_METAS.filter((token) => !token.protocolSlug && !mcapMap[token.id]);
    for (const token of noSlugTokens) {
      const mcap = token.geckoId ? cgData[token.geckoId]?.usd_market_cap : undefined;
      if (mcap && mcap > 0) mcapMap[token.id] = mcap;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const dayAgo = nowSec - 86400;
    const weekAgo = nowSec - 7 * 86400;
    const monthAgo = nowSec - 30 * 86400;

    const findNearestTvl = (
      history: { date: number; totalLiquidityUSD: number }[],
      targetSec: number,
    ): number | null => {
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

      return closest && closestDist < 2 * 86400 ? closest.totalLiquidityUSD : null;
    };

    return GOLD_METAS
      .map((meta) => {
        const priceInfo = priceData.coins[`coingecko:${meta.geckoId}`];
        if (!priceInfo) return null;

        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[gold] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        const history = tvlHistoryMap[meta.id];
        let usableHistory: typeof history | undefined;

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
        } as PeggedAsset;
      })
      .filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    console.error("[gold] fetchGoldTokens failed:", err);
    return [];
  }
}

async function fetchFiatCoinGeckoTokens(cgData: CoinGeckoMcapData): Promise<PeggedAsset[]> {
  if (FIAT_CG_METAS.length === 0) return [];

  try {
    const coinIds = FIAT_CG_METAS.map((token) => `coingecko:${token.geckoId}`).join(",");
    const priceRes = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);

    if (!priceRes || !priceRes.ok) {
      console.error(`[fiat-cg] Price fetch failed: ${priceRes?.status ?? "no response"}`);
      return [];
    }

    const priceData = (await priceRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };

    const mcapMap: Record<string, number> = {};
    for (const token of FIAT_CG_METAS) {
      const mcap = token.geckoId ? cgData[token.geckoId]?.usd_market_cap : undefined;
      if (mcap && mcap > 0) mcapMap[token.id] = mcap;
    }

    return FIAT_CG_METAS
      .map((meta) => {
        const priceInfo = priceData.coins[`coingecko:${meta.geckoId}`];
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
        } as PeggedAsset;
      })
      .filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    console.error("[fiat-cg] fetchFiatCoinGeckoTokens failed:", err);
    return [];
  }
}

export async function fetchCoinGeckoMarketData(): Promise<CoinGeckoMcapData> {
  const ids = [
    ...COMMODITY_TOKENS.filter((token) => !token.protocolSlug).map((token) => token.geckoId).filter(Boolean),
    ...FIAT_CG_METAS.map((token) => token.geckoId).filter(Boolean),
  ].join(",");

  if (!ids) return {};

  const res = await fetchWithRetry(
    cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true`),
    { headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }) },
  );

  if (!res || !res.ok) {
    console.error(`[sync-stablecoins] CoinGecko batch mcap fetch failed: ${res?.status ?? "no response"}`);
    return {};
  }

  return (await res.json()) as CoinGeckoMcapData;
}

export async function fetchSupplementalTrackedTokens(cgData: CoinGeckoMcapData): Promise<{
  goldTokens: PeggedAsset[];
  silverTokens: PeggedAsset[];
  fiatCgTokens: PeggedAsset[];
}> {
  const [goldTokens, silverTokens, fiatCgTokens] = await Promise.all([
    fetchGoldTokens(cgData),
    fetchSilverTokens(cgData),
    fetchFiatCoinGeckoTokens(cgData),
  ]);

  return { goldTokens, silverTokens, fiatCgTokens };
}
