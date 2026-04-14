import { DEFILLAMA_COINS } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { getCachedRequest } from "./request";
import type { AdapterContext } from "./types";

const DEFILLAMA_PRICE_CHAIN_ALIASES: Record<string, string> = {
  hyperevm: "hyperliquid",
};

function getDefiLlamaPriceAssetKey(chain: string, address: string): string {
  const resolvedChain = DEFILLAMA_PRICE_CHAIN_ALIASES[chain] ?? chain;
  return `${resolvedChain}:${address.toLowerCase()}`;
}

export async function fetchDefiLlamaPrices(
  assets: Array<{ key: string; chain: string; address: string }>,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  if (assets.length === 0) return new Map();

  const assetKeys = assets.map(({ chain, address }) => getDefiLlamaPriceAssetKey(chain, address));
  return getCachedRequest(
    `defillama-prices:${assetKeys.join(",")}`,
    async () => {
      const res = await fetchWithRetry(
        `${DEFILLAMA_COINS}/prices/current/${assetKeys.join(",")}`,
        { signal },
        2,
        { timeoutMs: 10_000 },
      );
      if (!res) {
        throw new Error("DefiLlama price fetch failed (no-response)");
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`DefiLlama price fetch failed (${res.status})`);
      }

      const body = (await res.json()) as {
        coins?: Record<string, { price?: number }>;
      };
      const priceMap = new Map<string, number>();

      for (const asset of assets) {
        const lookupKey = getDefiLlamaPriceAssetKey(asset.chain, asset.address);
        const price = body.coins?.[lookupKey]?.price;
        if (typeof price === "number" && price > 0) {
          priceMap.set(asset.key, price);
        }
      }

      return priceMap;
    },
    ctx,
  );
}
