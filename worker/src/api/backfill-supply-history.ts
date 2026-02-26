import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "../../../src/lib/psi-eligible";
import { DEFILLAMA_BASE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../lib/constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { batchExecute } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";
import { binarySearchNearest } from "../lib/binary-search";

const DEFAULT_BATCH_SIZE = 10;

interface TokenEntry {
  date: number; // unix seconds
  circulating?: Record<string, number>;
}

interface StablecoinDetail {
  price?: number;
  tokens?: TokenEntry[];
}

// Commodity tokens: use CoinGecko market_chart (historical market caps) as primary source.
// Protocol TVL from DefiLlama can diverge from token market cap (e.g. XAUT TVL includes
// multi-chain reserves that far exceed the token's market cap).

async function backfillCommodity(
  db: D1Database,
  id: string,
  config: { geckoId: string; protocolSlug?: string },
): Promise<{ rows: number; error?: string }> {
  // Try CoinGecko market_chart first — provides actual historical market caps.
  const cgRes = await fetch(
    cgUrl(`/coins/${config.geckoId}/market_chart?vs_currency=usd&days=max`),
    { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
  );

  if (cgRes.ok) {
    const cgData = (await cgRes.json()) as {
      market_caps: [number, number][];
      prices?: [number, number][];
    };

    const mcaps = cgData.market_caps ?? [];
    if (mcaps.length > 0) {
      const priceMap = new Map<number, number>();
      if (cgData.prices) {
        for (const [ts, p] of cgData.prices) {
          const snapshotDate = Math.floor(ts / 1000 / 86400) * 86400;
          priceMap.set(snapshotDate, p);
        }
      }

      const stmts: D1PreparedStatement[] = [];
      for (const [ts, mcap] of mcaps) {
        if (mcap <= 0) continue;
        const snapshotDate = Math.floor(ts / 1000 / 86400) * 86400;
        const price = priceMap.get(snapshotDate) ?? null;
        stmts.push(
          db
            .prepare(
              "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
            )
            .bind(id, snapshotDate, mcap, price),
        );
      }

      if (stmts.length > 0) {
        await batchExecute(db, stmts);
      }
      return { rows: stmts.length };
    }
  }

  // Fallback: protocol TVL (only if TVL ≈ mcap)
  if (!config.protocolSlug) {
    return { rows: 0, error: "CoinGecko unavailable and no protocolSlug for TVL fallback" };
  }

  const [protocolRes, priceRes] = await Promise.all([
    fetch(`${DEFILLAMA_API}/protocol/${config.protocolSlug}`, {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetch(`${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=0&span=500`, {
      headers: { "User-Agent": USER_AGENT },
    }),
  ]);

  if (!protocolRes.ok) {
    return { rows: 0, error: `protocol API returned ${protocolRes.status}` };
  }

  const protocolData = (await protocolRes.json()) as {
    mcap?: number;
    tvl?: { date: number; totalLiquidityUSD: number }[];
  };
  const tvlHistory = protocolData.tvl ?? [];
  if (tvlHistory.length === 0) {
    return { rows: 0, error: "no TVL history and CoinGecko unavailable" };
  }

  // Skip TVL if it diverges from mcap (same 15% threshold as sync code)
  const currentMcap = protocolData.mcap;
  if (currentMcap && tvlHistory.length > 0) {
    const latestTvl = tvlHistory[tvlHistory.length - 1].totalLiquidityUSD;
    const ratio = currentMcap / latestTvl;
    if (ratio < 0.85 || ratio > 1.15) {
      return { rows: 0, error: `TVL/mcap divergence (ratio=${ratio.toFixed(3)}), CoinGecko also unavailable` };
    }
  }

  let prices: { timestamp: number; price: number }[] = [];
  if (priceRes.ok) {
    const priceData = (await priceRes.json()) as {
      coins: Record<string, { prices: { timestamp: number; price: number }[] }>;
    };
    prices = priceData.coins?.[`coingecko:${config.geckoId}`]?.prices ?? [];
    prices.sort((a, b) => a.timestamp - b.timestamp);
  }

  function findPrice(date: number): number | null {
    return binarySearchNearest(prices, date, (p) => p.timestamp)?.price ?? null;
  }

  const stmts: D1PreparedStatement[] = [];
  for (const point of tvlHistory) {
    const mcap = point.totalLiquidityUSD;
    if (mcap <= 0) continue;
    const snapshotDate = Math.floor(point.date / 86400) * 86400;
    const price = findPrice(point.date);
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
        )
        .bind(id, snapshotDate, mcap, price),
    );
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }
  return { rows: stmts.length };
}

export const handleBackfillSupplyHistory = withErrorHandler(
  "backfill-supply-history",
  async (
    db: D1Database,
    url: URL,
    adminSecret?: string,
    request?: Request,
  ): Promise<Response> => {
    const authError = await requireAdmin(request, adminSecret);
    if (authError) return authError;

    const singleId = url.searchParams.get("stablecoin");

    let coins;
    if (singleId) {
      const match = PSI_ELIGIBLE_STABLECOINS.filter((c) => c.id === singleId);
      if (match.length === 0) {
        return new Response(
          JSON.stringify({ error: "Stablecoin not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      coins = match;
    } else {
      const batchSize = parseInt(
        url.searchParams.get("batchSize") ?? String(DEFAULT_BATCH_SIZE),
        10,
      );
      const batch = parseInt(url.searchParams.get("batch") ?? "0", 10);
      const start = batch * batchSize;
      coins = PSI_ELIGIBLE_STABLECOINS.slice(start, start + batchSize);
    }

    if (coins.length === 0) {
      return new Response(
        JSON.stringify({ message: "No coins in this batch" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    let totalRows = 0;
    const errors: string[] = [];
    const skipped: string[] = [];

    for (const meta of coins) {
      // Commodity tokens: backfill from CoinGecko market_chart (primary) or protocol TVL (fallback)
      const isCommodity = meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER";
      if (isCommodity && meta.geckoId) {
        try {
          const result = await backfillCommodity(db, meta.id, { geckoId: meta.geckoId, protocolSlug: meta.protocolSlug ?? undefined });
          if (result.error) {
            errors.push(`${meta.symbol}: ${result.error}`);
          } else {
            totalRows += result.rows;
          }
        } catch (err) {
          errors.push(`${meta.symbol}: commodity backfill failed — ${err}`);
        }
        continue;
      }

      // Skip other non-DefiLlama coins (no historical data available)
      if (/^(gold-|silver-|cg-)/.test(meta.id)) {
        skipped.push(meta.symbol);
        continue;
      }

      // Determine if this coin needs native→USD conversion
      const isUsd = meta.flags.pegCurrency === "USD";
      const needsConversion = !isUsd;
      const geckoId = meta.geckoId ?? PSI_ELIGIBLE_META_BY_ID.get(meta.id)?.geckoId;

      // Fetch DL detail + historical prices (for non-USD coins) in parallel
      const fetches: Promise<Response>[] = [
        fetch(
          `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(meta.id)}`,
          { headers: { "User-Agent": USER_AGENT } },
        ),
      ];
      if (needsConversion && geckoId) {
        fetches.push(
          fetch(`${DEFILLAMA_COINS}/chart/coingecko:${geckoId}?start=0&span=500`, {
            headers: { "User-Agent": USER_AGENT },
          }),
        );
      }

      let detail: StablecoinDetail | null = null;
      let historicalPrices: { timestamp: number; price: number }[] = [];
      try {
        const responses = await Promise.all(fetches);
        const detailRes = responses[0];
        if (!detailRes.ok) {
          errors.push(`${meta.symbol}: DL returned ${detailRes.status}`);
          continue;
        }
        detail = (await detailRes.json()) as StablecoinDetail;

        // Parse historical prices if fetched
        if (responses[1]?.ok) {
          const priceData = (await responses[1].json()) as {
            coins: Record<string, { prices: { timestamp: number; price: number }[] }>;
          };
          historicalPrices = priceData.coins?.[`coingecko:${geckoId}`]?.prices ?? [];
          historicalPrices.sort((a, b) => a.timestamp - b.timestamp);
        }
      } catch (err) {
        errors.push(`${meta.symbol}: fetch failed — ${err}`);
        continue;
      }

      const tokens = detail?.tokens;
      if (!tokens || tokens.length === 0) {
        skipped.push(meta.symbol);
        continue;
      }

      // For non-USD coins: fall back to DL's current price when historical prices unavailable
      const hasHistoricalPrices = historicalPrices.length > 0;
      const fallbackPrice = (needsConversion && detail?.price) ? detail.price : null;
      if (needsConversion && !hasHistoricalPrices) {
        if (fallbackPrice) {
          const reason = !geckoId ? "no geckoId" : "price API returned no data";
          console.warn(`[backfill] ${meta.symbol}: ${reason}, using DL current price $${fallbackPrice} as constant`);
        } else {
          errors.push(`${meta.symbol}: non-USD coin with no price data available — skipping`);
          continue;
        }
      }

      function findHistoricalPrice(date: number): number | null {
        return binarySearchNearest(historicalPrices, date, (p) => p.timestamp)?.price ?? null;
      }

      const stmts: D1PreparedStatement[] = [];

      for (const entry of tokens) {
        const circ = entry.circulating;
        if (!circ) continue;

        // Sum across all peg buckets (native currency for non-USD, USD for USD coins)
        const rawSum = Object.values(circ).reduce(
          (sum, v) => sum + (v ?? 0),
          0,
        );
        if (rawSum <= 0) continue;

        let marketCapUsd: number;
        let price: number | null = null;

        if (needsConversion) {
          // Non-USD: multiply native supply by USD price to get market cap
          price = findHistoricalPrice(entry.date) ?? fallbackPrice;
          if (!price || price <= 0) continue;
          marketCapUsd = rawSum * price;
        } else {
          // USD: rawSum is already in USD
          marketCapUsd = rawSum;
        }

        // Floor to UTC midnight
        const snapshotDate = Math.floor(entry.date / 86400) * 86400;

        stmts.push(
          db
            .prepare(
              "INSERT OR REPLACE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
            )
            .bind(meta.id, snapshotDate, marketCapUsd, price),
        );
      }

      if (stmts.length > 0) {
        await batchExecute(db, stmts);
        totalRows += stmts.length;
      }
    }

    return new Response(
      JSON.stringify({
        coinsProcessed: coins.length,
        rowsInserted: totalRows,
        skipped: skipped.length > 0 ? skipped : undefined,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
);
