import { logWorkerEventArgs } from "./structured-log";
import { z } from "zod";
import { fetchJsonWithRetry } from "./fetch-retry";
import type { FetcherOutcome } from "./fetcher-result";
import { toErrorMessage } from "./error-utils";

const HERMES_BASE = "https://hermes.pyth.network";

/** Maximum age (seconds) of a Pyth price feed before it's considered stale */
const PYTH_MAX_STALENESS_SEC = 300; // 5 minutes

const PYTH_REQUEST_TIMEOUT_MS = 10_000;

function normalizeFeedId(feedId: string): string {
  return feedId.toLowerCase().replace(/^0x/, "");
}

export interface PythPriceResult {
  price: number;
  confidence: number;       // raw confidence in USD
  confidenceBps: number;    // confidence as basis points of price
  publishTime: number;      // unix seconds
}

const PythPriceFeedSchema = z.object({
  parsed: z.array(z.object({
    id: z.string(),
    price: z.object({
      price: z.string(),
      expo: z.number(),
      conf: z.string(),
      publish_time: z.number(),
    }),
  })),
});

/**
 * Fetch latest prices from Pyth Hermes API.
 * Free public API, no auth required, 30 req/10s rate limit.
 *
 * @param feedIds Map of stablecoinId → Pyth price feed ID (hex)
 * @returns FetcherOutcome<Map<string, PythPriceResult>>
 */
export async function fetchPythPrices(
  feedIds: Map<string, string>,
  signal?: AbortSignal,
): Promise<FetcherOutcome<Map<string, PythPriceResult>>> {
  const results = new Map<string, PythPriceResult>();
  if (feedIds.size === 0) return { kind: "no-data", value: results };

  // Reverse map: feedId → stablecoinId
  const reverseMap = new Map<string, string>();
  for (const [coinId, feedId] of feedIds) {
    reverseMap.set(normalizeFeedId(feedId), coinId);
  }

  try {
    const ids = [...feedIds.values()].map((id) => `ids[]=${id}`).join("&");
    const result = await fetchJsonWithRetry<unknown>(
      `${HERMES_BASE}/v2/updates/price/latest?${ids}`,
      { signal, headers: { Accept: "application/json" } },
      1,
      { timeoutMs: PYTH_REQUEST_TIMEOUT_MS },
    );
    if (!result?.response.ok) {
      logWorkerEventArgs("lib", "warn", `[pyth] Hermes API returned ${result?.response.status ?? "no response"}`);
      return {
        kind: "upstream-error",
        value: results,
        reason: `Hermes API returned ${result?.response.status ?? "no response"}`,
      };
    }

    const data = PythPriceFeedSchema.parse(result.body);

    for (const feed of data.parsed) {
      const coinId = reverseMap.get(normalizeFeedId(feed.id));
      if (!coinId) continue;

      const rawPrice = BigInt(feed.price.price);
      const rawConf = BigInt(feed.price.conf);
      const expo = feed.price.expo;
      const multiplier = Math.pow(10, expo);

      const price = Number(rawPrice) * multiplier;
      const confidence = Number(rawConf) * multiplier;

      if (price <= 0) continue;

      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - feed.price.publish_time > PYTH_MAX_STALENESS_SEC) {
        logWorkerEventArgs("lib", "warn", `[pyth] Skipping stale feed for ${coinId}: publish_time=${feed.price.publish_time}, age=${nowSec - feed.price.publish_time}s`);
        continue;
      }

      const confidenceBps = Math.round((confidence / price) * 10000);

      results.set(coinId, {
        price,
        confidence,
        confidenceBps,
        publishTime: feed.price.publish_time,
      });
    }

    if (feedIds.size > 0 && results.size === 0) {
      logWorkerEventArgs("lib", "warn", `[pyth] Requested ${feedIds.size} feeds but Hermes returned 0 usable results`);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("lib", "warn", "[pyth] Fetch failed:", err);
    return {
      kind: "upstream-error",
      value: results,
      reason: toErrorMessage(err),
    };
  }

  return results.size > 0
    ? { kind: "ok", value: results }
    : { kind: "no-data", value: results };
}
