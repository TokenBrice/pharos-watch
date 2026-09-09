import { DEFILLAMA_COINS } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { getCachedRequest } from "./request";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";

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

  const lookups = assets.map(({ key, chain, address }) => ({
    key,
    assetKey: getDefiLlamaPriceAssetKey(chain, address),
  }));
  const assetKeys = lookups.map(({ assetKey }) => assetKey);
  // The upstream entry is keyed by asset identity alone, so callers asking for the
  // same assets share one fetch. Resolved prices carry each caller's own logical
  // keys, so they need one entry per caller-key set: sharing an entry across
  // aliases hands a caller another caller's keys. Callers such as
  // `fetchBranchPriceMap` extend the returned map with fallback prices, so cached
  // entries stay pristine and every call gets its own map.
  const upstreamCacheKey = `defillama-prices:${assetKeys.join(",")}`;
  const resolvedPrices = await getCachedRequest(
    `${upstreamCacheKey}|keys:${JSON.stringify(lookups.map(({ key }) => key))}`,
    async (): Promise<Array<[string, number]>> => {
      const upstreamPrices = await getCachedRequest(
        upstreamCacheKey,
        async () => runAdapterIo(ctx, `defillama-prices:${assetKeys.length}`, async () => {
          const result = await fetchTextWithRetry(
            `${DEFILLAMA_COINS}/prices/current/${assetKeys.join(",")}`,
            { signal },
            2,
            { timeoutMs: 10_000, returnFinalResponse: true },
          );
          if (!result) {
            throw new Error("DefiLlama price fetch failed (no-response)");
          }
          if (!result.response.ok) {
            throw new Error(`DefiLlama price fetch failed (${result.response.status})`);
          }

          const body = JSON.parse(result.body) as {
            coins?: Record<string, { price?: number }>;
          };
          const prices: Record<string, number> = {};

          for (const assetKey of assetKeys) {
            const price = body.coins?.[assetKey]?.price;
            if (typeof price === "number" && price > 0) {
              prices[assetKey] = price;
            }
          }

          return prices;
        }),
        ctx,
      );

      return lookups.flatMap(({ key, assetKey }) => {
        const price = upstreamPrices[assetKey];
        return price === undefined ? [] : [[key, price] as [string, number]];
      });
    },
    ctx,
  );

  return new Map(resolvedPrices);
}
