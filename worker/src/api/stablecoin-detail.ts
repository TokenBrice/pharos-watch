import { getCache, setCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";
import { DEFILLAMA_BASE, DEFILLAMA_COINS, DEFILLAMA_API, CACHE_PROFILES, USER_AGENT } from "../lib/constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { binarySearchNearest } from "../lib/binary-search";
import { TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

/** Fallback: build tokens array from D1 supply_history when external APIs have no data. */
async function fetchSupplyHistoryFallback(
  db: D1Database,
  id: string,
  pegType: string,
): Promise<Record<string, unknown>[]> {
  const result = await db
    .prepare(
      `SELECT snapshot_date, circulating_usd, price
       FROM supply_history
       WHERE stablecoin_id = ?
       ORDER BY snapshot_date ASC`
    )
    .bind(id)
    .all<{ snapshot_date: number; circulating_usd: number; price: number | null }>();

  return (result.results ?? [])
    .filter((row) => row.circulating_usd > 0)
    .map((row) => ({
      date: row.snapshot_date,
      totalCirculatingUSD: { [pegType]: row.circulating_usd },
      totalCirculating: {
        [pegType]: row.price && row.price > 0 ? row.circulating_usd / row.price : 0,
      },
    }));
}

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

  // Fallback: no protocol TVL → use CoinGecko market_chart directly
  if (tokens.length === 0) {
    const cgRes = await fetch(
      cgUrl(`/coins/${config.geckoId}/market_chart?vs_currency=usd&days=max`),
      { headers: cgHeaders({ "User-Agent": USER_AGENT }) }
    );
    if (cgRes.ok) {
      const cgData = (await cgRes.json()) as {
        market_caps: [number, number][];
        prices?: [number, number][];
      };
      const priceMap = new Map<string, number>();
      if (cgData.prices) {
        for (const [ts, p] of cgData.prices) {
          priceMap.set(new Date(ts).toISOString().slice(0, 10), p);
        }
      }
      tokens = (cgData.market_caps ?? [])
        .filter(([, mcap]) => mcap > 0)
        .map(([ts, mcap]) => {
          const date = Math.floor(ts / 1000);
          const dateKey = new Date(ts).toISOString().slice(0, 10);
          const price = priceMap.get(dateKey) ?? 0;
          return {
            date,
            totalCirculatingUSD: { [config.pegType]: mcap },
            totalCirculating: { [config.pegType]: price > 0 ? mcap / price : 0 },
          };
        });
    }
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
      let body = await fetchCommodityDetail(commodityConfig);

      // Fallback to D1 supply_history if external APIs returned no tokens
      const parsed = JSON.parse(body) as { tokens: unknown[] };
      if (!parsed.tokens || parsed.tokens.length === 0) {
        const fallbackTokens = await fetchSupplyHistoryFallback(db, id, commodityConfig.pegType);
        if (fallbackTokens.length > 0) {
          body = JSON.stringify({ tokens: fallbackTokens });
        }
      }

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

  // CoinGecko-only coins: fetch from CoinGecko market_chart API
  const isCgOnly = id.startsWith("cg-") && meta?.geckoId;
  if (isCgOnly) {
    const geckoId = meta.geckoId!;
    const pegType = `pegged${meta.flags.pegCurrency}`;
    try {
      let tokens: Record<string, unknown>[] = [];

      const cgRes = await fetch(
        cgUrl(`/coins/${geckoId}/market_chart?vs_currency=usd&days=max`),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }) }
      );
      if (cgRes.ok) {
        const cgData = (await cgRes.json()) as {
          market_caps: [number, number][];
          prices?: [number, number][];
        };

        // Build price lookup for computing totalCirculating (supply in token units)
        const priceMap = new Map<string, number>();
        if (cgData.prices) {
          for (const [ts, price] of cgData.prices) {
            priceMap.set(new Date(ts).toISOString().slice(0, 10), price);
          }
        }

        tokens = (cgData.market_caps ?? [])
          .filter(([, mcap]) => mcap > 0)
          .map(([ts, mcap]) => {
            const date = Math.floor(ts / 1000);
            const dateKey = new Date(ts).toISOString().slice(0, 10);
            const price = priceMap.get(dateKey) ?? 0;
            return {
              date,
              totalCirculatingUSD: { [pegType]: mcap },
              totalCirculating: { [pegType]: price > 0 ? mcap / price : 0 },
            };
          });
      }

      // Fallback to D1 supply_history if CoinGecko returned no data
      if (tokens.length === 0) {
        tokens = await fetchSupplyHistoryFallback(db, id, pegType);
      }

      const body = JSON.stringify({ tokens });
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
        JSON.stringify({ error: "Failed to fetch CoinGecko data" }),
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

    // Convert non-USD circulating values from native currency to USD.
    // DefiLlama stores non-USD values (BRL, RUB, JPY, etc.) in native units,
    // not USD — multiply by token price to get actual USD market cap.
    const isNonUSD = meta &&
      meta.flags.pegCurrency !== "USD" &&
      meta.flags.pegCurrency !== "GOLD" &&
      meta.flags.pegCurrency !== "SILVER";
    if (isNonUSD && typeof parsed.price === "number" && parsed.price > 0 && Array.isArray(parsed.tokens)) {
      const price = parsed.price;
      for (const entry of parsed.tokens) {
        if (entry.totalCirculatingUSD) {
          for (const key of Object.keys(entry.totalCirculatingUSD)) {
            if (key !== "peggedUSD") {
              entry.totalCirculatingUSD[key] *= price;
            }
          }
        }
        if (entry.circulating) {
          for (const key of Object.keys(entry.circulating)) {
            if (key !== "peggedUSD") {
              entry.circulating[key] *= price;
            }
          }
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
