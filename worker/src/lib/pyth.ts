import { z } from "zod";

const HERMES_BASE = "https://hermes.pyth.network";

/** Maximum age (seconds) of a Pyth price feed before it's considered stale */
const PYTH_MAX_STALENESS_SEC = 300; // 5 minutes

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
 * @returns Map of stablecoinId → PythPriceResult
 */
export async function fetchPythPrices(
  feedIds: Map<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, PythPriceResult>> {
  const results = new Map<string, PythPriceResult>();
  if (feedIds.size === 0) return results;

  // Reverse map: feedId → stablecoinId
  const reverseMap = new Map<string, string>();
  for (const [coinId, feedId] of feedIds) {
    reverseMap.set(normalizeFeedId(feedId), coinId);
  }

  try {
    const ids = [...feedIds.values()].map((id) => `ids[]=${id}`).join("&");
    const res = await fetch(
      `${HERMES_BASE}/v2/updates/price/latest?${ids}`,
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[pyth] Hermes API returned ${res.status}`);
      return results;
    }

    const data = PythPriceFeedSchema.parse(await res.json());

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
        console.warn(`[pyth] Skipping stale feed for ${coinId}: publish_time=${feed.price.publish_time}, age=${nowSec - feed.price.publish_time}s`);
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
      console.warn(`[pyth] Requested ${feedIds.size} feeds but Hermes returned 0 usable results`);
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[pyth] Fetch failed:", err);
  }

  return results;
}
