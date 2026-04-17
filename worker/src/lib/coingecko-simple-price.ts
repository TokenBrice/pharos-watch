import type { PriceObservedAtMode } from "@shared/types/core";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { FetcherOutcome } from "./fetcher-result";
import { cgUrl, cgHeaders } from "./coingecko";
import { USER_AGENT } from "./constants";
import { fetchWithRetry } from "./fetch-retry";
import { throwIfAborted } from "./abort";

const PRIMARY_CG_BATCH_SIZE = 250;

interface CoinGeckoSimplePriceValue {
  usd?: number;
  last_updated_at?: number;
}

export interface CoingeckoSimplePriceEntry {
  price: number;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

export async function fetchCoingeckoSimplePrices(
  geckoIds: string[],
  coingeckoApiKey: string | null,
  signal: AbortSignal | undefined,
  nowSec: number,
): Promise<FetcherOutcome<Map<string, CoingeckoSimplePriceEntry>>> {
  const prices = new Map<string, CoingeckoSimplePriceEntry>();
  const coingeckoMaxTrustedAgeSec =
    getPricingSourceRegistryEntry("coingecko")?.maxTrustedAgeSec ?? 15 * 60;
  let staleCount = 0;
  let hadBatchFailure = false;

  try {
    for (let i = 0; i < geckoIds.length; i += PRIMARY_CG_BATCH_SIZE) {
      throwIfAborted(signal);
      const batch = geckoIds.slice(i, i + PRIMARY_CG_BATCH_SIZE);
      const ids = batch.join(",");
      const res = await fetchWithRetry(
        cgUrl(`/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`, coingeckoApiKey),
        {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey),
          signal,
        },
      );
      if (!res?.ok) {
        hadBatchFailure = true;
        console.warn(`[primary-prices] CG price API returned ${res?.status ?? "no response"}`);
        continue;
      }

      const data = (await res.json()) as Record<string, CoinGeckoSimplePriceValue>;
      for (const [gId, val] of Object.entries(data)) {
        if (val?.usd == null || !(val.usd > 0)) continue;
        const upstreamObservedAt =
          typeof val.last_updated_at === "number" &&
          Number.isFinite(val.last_updated_at) &&
          val.last_updated_at > 0
            ? val.last_updated_at
            : null;
        if (
          upstreamObservedAt != null &&
          nowSec - upstreamObservedAt > coingeckoMaxTrustedAgeSec
        ) {
          staleCount++;
          continue;
        }
        prices.set(gId, {
          price: val.usd,
          observedAt: upstreamObservedAt,
          observedAtMode: upstreamObservedAt != null ? "upstream" : null,
        });
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[primary-prices] CG price API failed:", err);
    return {
      kind: "upstream-error",
      value: prices,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (staleCount > 0) {
    console.warn(
      `[primary-prices] Dropped ${staleCount} stale CoinGecko simple-price row(s) older than ${coingeckoMaxTrustedAgeSec}s`,
    );
  }

  if (hadBatchFailure) {
    return { kind: "upstream-error", value: prices, reason: "one or more CG batches failed" };
  }
  if (prices.size === 0) {
    return { kind: "no-data", value: prices };
  }
  return { kind: "ok", value: prices };
}
