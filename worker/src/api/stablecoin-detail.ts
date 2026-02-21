import { getCache, setCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";
import { DEFILLAMA_BASE, DEFILLAMA_COINS, DEFILLAMA_API, SUPPLY_OVERRIDE_COINS, CACHE_PROFILES } from "../lib/constants";
import { binarySearchNearest } from "../lib/binary-search";
import { TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import { sumPegBuckets } from "../../../src/lib/supply";

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

function findNearestPrice(
  sortedPrices: { timestamp: number; price: number }[],
  date: number,
): number {
  return binarySearchNearest(sortedPrices, date, (p) => p.timestamp)?.price ?? 0;
}

async function fetchCommodityDetail(config: {
  geckoId: string;
  protocolSlug: string;
  pegType: string;
}): Promise<string> {
  const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * 86400;

  const [priceRes, protocolRes] = await Promise.all([
    fetch(
      `${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=${twoYearsAgo}&span=730`
    ),
    config.protocolSlug
      ? fetch(`${DEFILLAMA_API}/protocol/${config.protocolSlug}`)
      : Promise.resolve(null),
  ]);

  let prices: { timestamp: number; price: number }[] = [];
  if (priceRes.ok) {
    const priceData = (await priceRes.json()) as {
      coins: Record<
        string,
        { prices: { timestamp: number; price: number }[] }
      >;
    };
    prices =
      priceData.coins?.[`coingecko:${config.geckoId}`]?.prices ?? [];
  }

  let tvlHistory: { date: number; totalLiquidityUSD: number }[] = [];
  if (protocolRes && protocolRes.ok) {
    const protocolData = (await protocolRes.json()) as {
      tvl?: { date: number; totalLiquidityUSD: number }[];
    };
    tvlHistory = protocolData.tvl ?? [];
  }

  // Merge TVL history with price data to produce chart-compatible tokens array.
  // totalCirculatingUSD / totalCirculating = price (used by PriceChart)
  // totalCirculatingUSD = market cap in USD (used by McapChart)
  let tokens: Record<string, unknown>[] = [];

  if (tvlHistory.length > 0 && prices.length > 0) {
    const sortedPrices = [...prices].sort(
      (a, b) => a.timestamp - b.timestamp
    );
    tokens = tvlHistory.map((point) => {
      const price = findNearestPrice(sortedPrices, point.date);
      const mcap = point.totalLiquidityUSD;
      return {
        date: point.date,
        totalCirculatingUSD: { [config.pegType]: mcap },
        totalCirculating: {
          [config.pegType]: price > 0 ? mcap / price : 0,
        },
      };
    });
  }

  return JSON.stringify({ tokens });
}

export const handleStablecoinDetail = withErrorHandler("stablecoin-detail", async (
  db: D1Database,
  id: string,
  ctx: ExecutionContext
): Promise<Response> => {
  const cacheKey = `detail:${id}`;
  const cached = await getCache(db, cacheKey);

  if (cached) {
    const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
    if (age < CACHE_TTL_SECONDS) {
      return new Response(cached.value, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS - age}, max-age=10`,
        },
      });
    }
  }

  // Commodity tokens (gold/silver): fetch from DefiLlama coins chart + protocol APIs
  const meta = TRACKED_META_BY_ID.get(id);
  const isCommodity = meta && (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") && meta.geckoId;
  if (isCommodity) {
    const commodityConfig = {
      geckoId: meta.geckoId!,
      protocolSlug: meta.protocolSlug ?? "",
      pegType: `pegged${meta.flags.pegCurrency}`,
    };
    try {
      const body = await fetchCommodityDetail(commodityConfig);
      ctx.waitUntil(setCache(db, cacheKey, body));
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=10`,
        },
      });
    } catch {
      if (cached) {
        return new Response(cached.value, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": CACHE_PROFILES.realtime,
          },
        });
      }
      return new Response(
        JSON.stringify({ error: "Failed to fetch commodity token data" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // Regular stablecoins: fetch from DefiLlama stablecoin API
  const res = await fetch(`${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(id)}`);
  if (!res.ok) {
    // If we have stale cache, return it rather than error
    if (cached) {
      return new Response(cached.value, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": CACHE_PROFILES.realtime,
        },
      });
    }
    return new Response(JSON.stringify({ error: `Failed to fetch stablecoin ${id}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body = await res.text();

  // Validate JSON structure before caching — skip cache on parse failure
  try {
    const parsed = JSON.parse(body);

    // For force-override coins, patch recent token entries with corrected supply from cache
    const forceOverride = SUPPLY_OVERRIDE_COINS.find((c) => c.llamaId === id && c.force);
    if (forceOverride && parsed.tokens && Array.isArray(parsed.tokens)) {
      const stablecoinsCache = await getCache(db, "stablecoins");
      if (stablecoinsCache) {
        try {
          const cacheData = JSON.parse(stablecoinsCache.value) as {
            peggedAssets?: { id: unknown; price?: number | null; circulating?: Record<string, number> }[];
          };
          const cachedAsset = cacheData.peggedAssets?.find((a) => String(a.id) === id);
          if (cachedAsset?.circulating) {
            const correctedMcap = sumPegBuckets(cachedAsset.circulating);
            if (correctedMcap > 0) {
              const assetPrice = typeof cachedAsset.price === "number" && cachedAsset.price > 0
                ? cachedAsset.price : null;
              // Patch last 7 entries (covers ~1 week of daily data points)
              const patchCount = Math.min(7, parsed.tokens.length);
              for (let i = parsed.tokens.length - patchCount; i < parsed.tokens.length; i++) {
                const entry = parsed.tokens[i];
                if (entry.totalCirculatingUSD) {
                  entry.totalCirculatingUSD = { [forceOverride.pegKey]: correctedMcap };
                }
                if (entry.totalCirculating) {
                  // Compute supply in token units: mcap / price
                  // (totalCirculatingUSD / totalCirculating = price for PriceChart)
                  entry.totalCirculating = {
                    [forceOverride.pegKey]: assetPrice ? correctedMcap / assetPrice : correctedMcap,
                  };
                }
              }
              console.log(`[detail] Patched ${patchCount} recent entries for ${id} with corrected mcap $${correctedMcap.toFixed(0)}`);
            }
          }
        } catch {
          // Stablecoins cache parse failed — continue with unpatched data
        }
      }
      body = JSON.stringify(parsed);
    }

    ctx.waitUntil(setCache(db, cacheKey, body));
  } catch {
    console.warn(`[detail] Invalid JSON response for ${id}, skipping cache write`);
    if (cached) {
      return new Response(cached.value, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": CACHE_PROFILES.realtime,
        },
      });
    }
    return new Response(
      JSON.stringify({ error: `Invalid upstream data for stablecoin ${id}` }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=10`,
    },
  });
});
