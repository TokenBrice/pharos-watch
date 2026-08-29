import { logWorkerEventArgs } from "./structured-log";
import type { PriceObservedAtMode } from "@shared/types/core";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { FetcherOutcome } from "./fetcher-result";
import { cgHeaders, cgSimplePricePath, cgUrl } from "./coingecko";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry } from "./fetch-retry";
import { throwIfAborted } from "./abort";
import { CoinGeckoSimplePriceSchema } from "./upstream-schemas";
import { toErrorMessage } from "@shared/lib/error-utils";

const PRIMARY_CG_BATCH_SIZE = 250;

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
  options?: { sourceKey?: string },
): Promise<FetcherOutcome<Map<string, CoingeckoSimplePriceEntry>>> {
  const prices = new Map<string, CoingeckoSimplePriceEntry>();
  const coingeckoMaxTrustedAgeSec =
    getPricingSourceRegistryEntry(options?.sourceKey ?? "coingecko")?.maxTrustedAgeSec ?? 15 * 60;
  let staleCount = 0;
  let hadBatchFailure = false;

  try {
    for (let i = 0; i < geckoIds.length; i += PRIMARY_CG_BATCH_SIZE) {
      throwIfAborted(signal);
      const batch = geckoIds.slice(i, i + PRIMARY_CG_BATCH_SIZE);
      const ids = batch.join(",");
      const result = await fetchJsonWithRetry<unknown>(
        cgUrl(cgSimplePricePath(`ids=${ids}&vs_currencies=usd&include_last_updated_at=true`), coingeckoApiKey),
        {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey),
          signal,
        },
      );
      if (!result?.response.ok) {
        hadBatchFailure = true;
        logWorkerEventArgs("lib", "warn", `[primary-prices] CG price API returned ${result?.response.status ?? "no response"}`);
        continue;
      }

      const parsed = CoinGeckoSimplePriceSchema.safeParse(result.body);
      if (!parsed.success) {
        hadBatchFailure = true;
        logWorkerEventArgs("lib", "warn", `[primary-prices] CG price API payload invalid: ${parsed.error.message}`);
        continue;
      }
      const data = parsed.data;
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
    logWorkerEventArgs("lib", "warn", "[primary-prices] CG price API failed:", err);
    return {
      kind: "upstream-error",
      value: prices,
      reason: toErrorMessage(err),
    };
  }

  if (staleCount > 0) {
    logWorkerEventArgs("lib", "warn",
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
