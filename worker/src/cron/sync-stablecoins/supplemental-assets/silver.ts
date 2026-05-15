import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { StablecoinMeta } from "@shared/types/core";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../../lib/response-body";
import { USER_AGENT } from "../../../lib/constants";
import { cgHeaders, cgUrl } from "../../../lib/coingecko";
import { resolveMarketCap } from "../../../lib/resolve-market-cap";
import { throwIfAborted } from "../../../lib/abort";
import type { PeggedAsset } from "../enrich-prices";
import {
  buildPricedSupplementalAsset,
  fetchSupplementalPriceData,
  resolveSupplementalPrice,
  type CoinGeckoMcapData,
} from "./shared";

const SILVER_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "SILVER");

async function fetchCoinGeckoCirculatingSupplyMap(
  metas: StablecoinMeta[],
  logPrefix: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<Map<string, number>> {
  const cgIds = metas.map((token) => token.geckoId).filter(Boolean).join(",");
  if (!cgIds) return new Map();

  const cgMarketsRes = await fetchWithRetry(
    cgUrl(`/coins/markets?vs_currency=usd&ids=${cgIds}`, coingeckoApiKey ?? null),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!cgMarketsRes?.ok) {
    await cancelResponseBodyQuietly(cgMarketsRes);
    console.warn(
      `[${logPrefix}] CG markets fetch failed (${cgMarketsRes?.status ?? "no response"}), falling back to cgData mcap`,
    );
    return new Map();
  }

  let cgMarketsRaw: unknown;
  try {
    cgMarketsRaw = await cgMarketsRes.json();
  } catch (err) {
    await cancelResponseBodyQuietly(cgMarketsRes);
    console.warn(`[${logPrefix}] CG markets payload parse failed:`, err);
    return new Map();
  }
  if (!Array.isArray(cgMarketsRaw)) {
    console.warn(`[${logPrefix}] CG markets returned unexpected shape, falling back to cgData mcap`);
    return new Map();
  }

  const supplyMap = new Map<string, number>();
  for (const item of cgMarketsRaw as Array<{ id: string; circulating_supply?: number }>) {
    if (item.circulating_supply != null && item.circulating_supply > 0) {
      supplyMap.set(item.id, item.circulating_supply);
    }
  }
  return supplyMap;
}

export async function fetchSilverTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<PeggedAsset[]> {
  if (SILVER_METAS.length === 0) return [];
  throwIfAborted(signal);

  try {
    const [priceData, cgSupplyMap] = await Promise.all([
      fetchSupplementalPriceData(SILVER_METAS, "silver", signal),
      fetchCoinGeckoCirculatingSupplyMap(SILVER_METAS, "silver", signal, coingeckoApiKey),
    ]);

    const mcapMap: Record<string, number> = {};
    for (const token of SILVER_METAS) {
      if (!token.geckoId) continue;
      const cgMcap = cgData[token.geckoId]?.usd_market_cap;
      const circulatingSupply = cgSupplyMap.get(token.geckoId);
      const priceResolution = resolveSupplementalPrice(priceData, cgData, token.geckoId);
      const price = priceResolution?.price ?? 0;
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
        const mcap = mcapMap[meta.id] ?? 0;
        if (!mcap) {
          console.warn(`[silver] No mcap for ${meta.symbol}, including with mcap=0`);
        }

        return buildPricedSupplementalAsset(meta, priceData, cgData, {
          mcap,
          supplySource: "coingecko-fallback",
        });
      })
      .filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.error("[silver] fetchSilverTokens failed:", err);
    return [];
  }
}
