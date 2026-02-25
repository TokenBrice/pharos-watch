import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { USER_AGENT } from "../lib/constants";
import { batchExecute } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { withErrorHandler } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";

const DEFAULT_BATCH_SIZE = 10;
const CG_DELAY_MS = 200; // 500 req/min budget → 200ms between calls

interface CoinResult {
  id: string;
  symbol: string;
  pricesFilled: number;
  rowsInserted: number;
}

export const handleBackfillCgPrices = withErrorHandler(
  "backfill-cg-prices",
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

    let totalPricesFilled = 0;
    let totalRowsInserted = 0;
    const coinDetails: CoinResult[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const meta of coins) {
      if (!meta.geckoId) {
        skipped.push(`${meta.symbol} (no geckoId)`);
        continue;
      }

      // Rate-limit CoinGecko calls
      if (coinDetails.length > 0 || skipped.length > 0 || errors.length > 0) {
        await new Promise((r) => setTimeout(r, CG_DELAY_MS));
      }

      // Fetch historical prices + market caps from CoinGecko
      const cgRes = await fetchWithRetry(
        cgUrl(`/coins/${meta.geckoId}/market_chart?vs_currency=usd&days=max`),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }) },
        2,
        { timeoutMs: 30_000 },
      );

      if (!cgRes) {
        errors.push(`${meta.symbol}: CoinGecko fetch failed (geckoId=${meta.geckoId})`);
        continue;
      }

      const cgData = (await cgRes.json()) as {
        prices: [number, number][];
        market_caps: [number, number][];
      };

      const cgPrices = cgData.prices ?? [];
      const cgMarketCaps = cgData.market_caps ?? [];

      if (cgPrices.length === 0) {
        skipped.push(`${meta.symbol} (no CG price data)`);
        continue;
      }

      // Build maps: date → price, date → market_cap (normalized to UTC midnight)
      const priceByDate = new Map<number, number>();
      for (const [ts, price] of cgPrices) {
        if (price <= 0) continue;
        const snapshotDate = Math.floor(ts / 1000 / 86400) * 86400;
        priceByDate.set(snapshotDate, price);
      }

      const mcapByDate = new Map<number, number>();
      for (const [ts, mcap] of cgMarketCaps) {
        if (mcap <= 0) continue;
        const snapshotDate = Math.floor(ts / 1000 / 86400) * 86400;
        mcapByDate.set(snapshotDate, mcap);
      }

      // Query existing rows for this coin
      const existing = await db
        .prepare(
          "SELECT snapshot_date, price, circulating_usd FROM supply_history WHERE stablecoin_id = ?",
        )
        .bind(meta.id)
        .all<{ snapshot_date: number; price: number | null; circulating_usd: number }>();

      const existingRows = existing.results ?? [];
      const existingDates = new Map<number, { price: number | null; circulatingUsd: number }>();
      for (const row of existingRows) {
        existingDates.set(row.snapshot_date, {
          price: row.price,
          circulatingUsd: row.circulating_usd,
        });
      }

      const stmts: D1PreparedStatement[] = [];
      let pricesFilled = 0;
      let rowsInserted = 0;

      for (const [date, price] of priceByDate) {
        const existingRow = existingDates.get(date);

        if (existingRow) {
          // Existing row with NULL price → fill it
          if (existingRow.price === null) {
            stmts.push(
              db
                .prepare(
                  "UPDATE supply_history SET price = ? WHERE stablecoin_id = ? AND snapshot_date = ? AND price IS NULL",
                )
                .bind(price, meta.id, date),
            );
            pricesFilled++;
          }
          // Existing row with price → skip (preserve DL data)
        } else {
          // No existing row → insert with market cap if available
          const mcap = mcapByDate.get(date);
          if (mcap && mcap > 0) {
            stmts.push(
              db
                .prepare(
                  "INSERT OR IGNORE INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)",
                )
                .bind(meta.id, date, mcap, price),
            );
            rowsInserted++;
          }
        }
      }

      if (stmts.length > 0) {
        await batchExecute(db, stmts);
      }

      totalPricesFilled += pricesFilled;
      totalRowsInserted += rowsInserted;
      coinDetails.push({
        id: meta.id,
        symbol: meta.symbol,
        pricesFilled,
        rowsInserted,
      });
    }

    return new Response(
      JSON.stringify({
        coinsProcessed: coinDetails.length,
        totalPricesFilled,
        totalRowsInserted,
        coinDetails: coinDetails.length > 0 ? coinDetails : undefined,
        skipped: skipped.length > 0 ? skipped : undefined,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
);
