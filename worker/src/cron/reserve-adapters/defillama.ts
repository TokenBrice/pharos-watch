import { z } from "zod";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { DEFILLAMA_COINS } from "../../lib/constants";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES, fetchTextWithRetry } from "../../lib/fetch-retry";
import { createRequestBodyObserver, getCachedRequest } from "./request";
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

export function defillamaAssetKey(chain: string, address: string): string {
  return `${DEFILLAMA_PRICE_CHAIN_ALIASES[chain] ?? chain}:${chain === "solana" ? address : address.toLowerCase()}`;
}

export interface BranchPriceObservation {
  sourceKind: "configured-nominal" | "pinned-oracle" | "market-api";
  sourceLookup: string;
  quoteTimestamp: number | null;
  quoteConfidence: number | null;
}

export interface DefiLlamaPriceResult {
  prices: Map<string, number>;
  warnings: LiveReserveWarning[];
}

export async function fetchDefiLlamaPrices(
  assets: Array<{ key: string; chain: string; address: string }>,
  signal: AbortSignal,
  ctx?: AdapterContext,
  observations?: Map<string, BranchPriceObservation>,
): Promise<DefiLlamaPriceResult> {
  if (assets.length === 0) return { prices: new Map(), warnings: [] };
  const lookups = assets.map(({ key, chain, address }) => ({
    key,
    assetKey: defillamaAssetKey(chain, address),
  }));
  const assetKeys = [...new Set(lookups.map(({ assetKey }) => assetKey))].sort();
  const quotes = await getCachedRequest(`defillama-prices:${assetKeys.join(",")}`, async () =>
    runAdapterIo(ctx, `defillama-prices:${assetKeys.length}`, async () => {
      const observation = createRequestBodyObserver(ctx, DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES);
      const result = await fetchTextWithRetry(
        `${DEFILLAMA_COINS}/prices/current/${assetKeys.join(",")}`,
        { signal }, 2, {
          timeoutMs: 10_000, returnFinalResponse: true, throwOnFinalNetworkError: true,
          onBodyRead: observation.onBodyRead,
        },
      );
      if (!result) throw new Error("DefiLlama price fetch failed (no-response)");
      if (!result.response.ok) throw new Error(`DefiLlama price fetch failed (${result.response.status})`);
      return {
        value: quotePayloadSchema.parse(JSON.parse(result.body)).coins ?? {},
        cacheBytes: observation.intakeBytes == null ? null : 8 * observation.intakeBytes,
        basis: "intake-estimate" as const,
      };
    }), ctx);
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const prices = new Map<string, number>();
  const warnings: LiveReserveWarning[] = [];
  for (const { key, assetKey } of lookups) {
    const quote = quotes[assetKey];
    if (!quote || typeof quote.price !== "number" || !Number.isFinite(quote.price) || quote.price <= 0) {
      const message = `DefiLlama quote ${assetKey} is missing or non-numeric`;
      warnings.push(reserveDegradedWarning("defillama-quote-missing", message));
      continue;
    }
    const stale = typeof quote.timestamp !== "number" || !Number.isFinite(quote.timestamp)
      || quote.timestamp <= 0 || now - quote.timestamp > 86_400;
    const future = typeof quote.timestamp === "number" && Number.isFinite(quote.timestamp)
      && quote.timestamp - now > MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC;
    const uncertain = typeof quote.confidence !== "number" || !Number.isFinite(quote.confidence) || quote.confidence < 0.8;
    if (stale || future || uncertain) {
      const failures = [
        ...(stale ? ["one-day freshness"] : []),
        ...(future ? ["future timestamp skew"] : []),
        ...(uncertain ? ["0.8 confidence"] : []),
      ];
      const message = `DefiLlama quote ${assetKey} fails ${failures.join(" and ")} policy`;
      warnings.push(reserveDegradedWarning("defillama-quote-quality", message));
    }
    prices.set(key, quote.price);
    observations?.set(key, {
      sourceKind: "market-api",
      sourceLookup: assetKey,
      quoteTimestamp: typeof quote.timestamp === "number" && Number.isFinite(quote.timestamp) && quote.timestamp > 0
        ? quote.timestamp : null,
      quoteConfidence: typeof quote.confidence === "number" && Number.isFinite(quote.confidence)
        ? quote.confidence : null,
    });
  }
  return { prices, warnings };
}
