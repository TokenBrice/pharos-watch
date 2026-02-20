import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { DEFILLAMA_BASE, DEFILLAMA_API, DEFILLAMA_COINS, USER_AGENT } from "../lib/constants";
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
  tokens?: TokenEntry[];
}

// Commodity tokens eligible for backfill: must have both geckoId and protocolSlug (for TVL history)

async function backfillCommodity(
  db: D1Database,
  id: string,
  config: { geckoId: string; protocolSlug: string },
): Promise<{ rows: number; error?: string }> {
  const [protocolRes, priceRes] = await Promise.all([
    fetch(`${DEFILLAMA_API}/protocol/${config.protocolSlug}`, {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetch(`${DEFILLAMA_COINS}/chart/coingecko:${config.geckoId}?start=0&span=2000`, {
      headers: { "User-Agent": USER_AGENT },
    }),
  ]);

  if (!protocolRes.ok) {
    return { rows: 0, error: `protocol API returned ${protocolRes.status}` };
  }

  const protocolData = (await protocolRes.json()) as {
    tvl?: { date: number; totalLiquidityUSD: number }[];
  };
  const tvlHistory = protocolData.tvl ?? [];
  if (tvlHistory.length === 0) {
    return { rows: 0, error: "no TVL history" };
  }

  // Build price lookup for converting mcap → price
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
          "INSERT OR IGNORE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
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
      const match = TRACKED_STABLECOINS.filter((c) => c.id === singleId);
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
      coins = TRACKED_STABLECOINS.slice(start, start + batchSize);
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
      // Commodity tokens with protocolSlug: backfill from protocol TVL API
      const isCommodity = meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER";
      if (isCommodity && meta.geckoId && meta.protocolSlug) {
        try {
          const result = await backfillCommodity(db, meta.id, { geckoId: meta.geckoId, protocolSlug: meta.protocolSlug });
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

      let detail: StablecoinDetail | null = null;
      try {
        const res = await fetch(
          `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(meta.id)}`,
          { headers: { "User-Agent": USER_AGENT } },
        );
        if (!res.ok) {
          errors.push(`${meta.symbol}: DL returned ${res.status}`);
          continue;
        }
        detail = (await res.json()) as StablecoinDetail;
      } catch (err) {
        errors.push(`${meta.symbol}: fetch failed — ${err}`);
        continue;
      }

      const tokens = detail?.tokens;
      if (!tokens || tokens.length === 0) {
        skipped.push(meta.symbol);
        continue;
      }

      const stmts: D1PreparedStatement[] = [];

      for (const entry of tokens) {
        const circ = entry.circulating;
        if (!circ) continue;

        const circulatingUsd = Object.values(circ).reduce(
          (sum, v) => sum + (v ?? 0),
          0,
        );
        if (circulatingUsd <= 0) continue;

        // Floor to UTC midnight
        const snapshotDate =
          Math.floor(entry.date / 86400) * 86400;

        stmts.push(
          db
            .prepare(
              "INSERT OR IGNORE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
            )
            .bind(meta.id, snapshotDate, circulatingUsd, null),
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
