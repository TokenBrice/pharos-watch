import { z } from "zod";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { DEFILLAMA_COINS } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { getCachedRequest } from "./request";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { reserveDegradedWarning } from "./warnings";

const DEFILLAMA_PRICE_CHAIN_ALIASES: Record<string, string> = { hyperevm: "hyperliquid" };
const quotePayloadSchema = z.object({
  coins: z.record(z.string(), z.object({
    price: z.number().optional(),
    timestamp: z.number().optional(),
    confidence: z.number().optional(),
  })).optional(),
});

export async function fetchDefiLlamaPrices(
  assets: Array<{ key: string; chain: string; address: string }>,
  signal: AbortSignal,
  ctx?: AdapterContext,
  warnings?: LiveReserveWarning[],
): Promise<Map<string, number>> {
  if (assets.length === 0) return new Map();
  const lookups = assets.map(({ key, chain, address }) => ({
    key,
    assetKey: `${DEFILLAMA_PRICE_CHAIN_ALIASES[chain] ?? chain}:${chain === "solana" ? address : address.toLowerCase()}`,
  }));
  const assetKeys = [...new Set(lookups.map(({ assetKey }) => assetKey))].sort();
  const quotes = await getCachedRequest(`defillama-prices:${assetKeys.join(",")}`, async () =>
    runAdapterIo(ctx, `defillama-prices:${assetKeys.length}`, async () => {
      const result = await fetchTextWithRetry(
        `${DEFILLAMA_COINS}/prices/current/${assetKeys.join(",")}`,
        { signal }, 2, { timeoutMs: 10_000, returnFinalResponse: true },
      );
      if (!result) throw new Error("DefiLlama price fetch failed (no-response)");
      if (!result.response.ok) throw new Error(`DefiLlama price fetch failed (${result.response.status})`);
      return quotePayloadSchema.parse(JSON.parse(result.body)).coins ?? {};
    }), ctx);
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const prices = new Map<string, number>();
  for (const { key, assetKey } of lookups) {
    const quote = quotes[assetKey];
    if (!quote || typeof quote.price !== "number" || !Number.isFinite(quote.price) || quote.price <= 0) continue;
    const stale = typeof quote.timestamp !== "number" || !Number.isFinite(quote.timestamp)
      || quote.timestamp <= 0 || now - quote.timestamp > 86_400;
    const uncertain = typeof quote.confidence !== "number" || !Number.isFinite(quote.confidence) || quote.confidence < 0.8;
    if (stale || uncertain) {
      const message = `DefiLlama quote ${assetKey} fails ${stale ? "one-day freshness" : ""}${stale && uncertain ? " and " : ""}${uncertain ? "0.8 confidence" : ""} policy`;
      if (!warnings) throw new Error(message);
      warnings.push(reserveDegradedWarning("defillama-quote-quality", message));
    }
    prices.set(key, quote.price);
  }
  return prices;
}
