import { getCache, setCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";
import { DEFILLAMA_BASE, DEFILLAMA_COINS, DEFILLAMA_API } from "../lib/constants";

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

// Data sources for gold tokens (not in DefiLlama's stablecoin API)
const GOLD_TOKEN_SOURCES: Record<string, { geckoId: string; protocolSlug: string }> = {
  "gold-xaut": { geckoId: "tether-gold", protocolSlug: "tether-gold" },
  "gold-paxg": { geckoId: "pax-gold", protocolSlug: "paxos-gold" },
  "gold-kau": { geckoId: "kinesis-gold", protocolSlug: "" },
  "gold-xaum": { geckoId: "matrixdock-gold", protocolSlug: "" },
  "gold-vro": { geckoId: "veraone", protocolSlug: "" },
  "gold-cgo": { geckoId: "comtech-gold", protocolSlug: "" },
};

function findNearestPrice(
  sortedPrices: { timestamp: number; price: number }[],
  date: number
): number {
  if (sortedPrices.length === 0) return 0;
  let lo = 0,
    hi = sortedPrices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedPrices[mid].timestamp < date) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const prev = sortedPrices[lo - 1];
    const curr = sortedPrices[lo];
    if (Math.abs(prev.timestamp - date) < Math.abs(curr.timestamp - date)) {
      return prev.price;
    }
  }
  return sortedPrices[lo].price;
}

async function fetchGoldDetail(config: {
  geckoId: string;
  protocolSlug: string;
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
  // totalCirculatingUSD = market cap in USD (used by SupplyChart)
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
        totalCirculatingUSD: { peggedGOLD: mcap },
        totalCirculating: {
          peggedGOLD: price > 0 ? mcap / price : 0,
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

  // Gold tokens: fetch from DefiLlama coins chart + protocol APIs
  if (id.startsWith("gold-")) {
    const config = GOLD_TOKEN_SOURCES[id];
    if (!config) {
      return new Response(
        JSON.stringify({ error: "Unknown gold token" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const body = await fetchGoldDetail(config);
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
            "Cache-Control": "public, s-maxage=60, max-age=10",
          },
        });
      }
      return new Response(
        JSON.stringify({ error: "Failed to fetch gold token data" }),
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
          "Cache-Control": "public, s-maxage=60, max-age=10",
        },
      });
    }
    return new Response(JSON.stringify({ error: `Failed to fetch stablecoin ${id}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await res.text();

  // Validate JSON structure before caching — skip cache on parse failure
  try {
    JSON.parse(body);
    ctx.waitUntil(setCache(db, cacheKey, body));
  } catch {
    console.warn(`[detail] Invalid JSON response for ${id}, skipping cache write`);
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=10`,
    },
  });
});
