import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { USER_AGENT } from "../lib/constants";
import { batchExecute } from "../lib/db";
import { fetchJsonWithRetry } from "../lib/fetch-retry";
import { jsonResponse } from "../lib/api-utils";
import { RATE_LIMITS } from "../lib/rate-limit";
import { noCoinsInBatchResponse, selectBackfillCoins } from "../lib/backfill-query";
import { runAdminRoute } from "../lib/route-wrappers";
import {
  fetchMarketBackfillPriceSeries,
  type HistoricalMarketSourceDiagnostics,
  type PricePoint,
} from "./backfill-price-sources";

const DEFAULT_BATCH_SIZE = 10;

interface CoinResult {
  id: string;
  symbol: string;
  pricesFilled: number;
  rowsInserted: number;
  diagnostics?: HistoricalMarketSourceDiagnostics;
}

export interface BackfillCgPricesRouteContext {
  db: D1Database;
  url: URL;
  coingeckoApiKey?: string | null;
}

async function executeBackfillCgPrices(db: D1Database, url: URL, cgApiKey?: string | null): Promise<Response> {
  const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
    defaultBatchSize: DEFAULT_BATCH_SIZE,
  });
  if ("response" in selection) {
    return selection.response;
  }
  const coins = selection.coins;

  if (coins.length === 0) {
    return noCoinsInBatchResponse();
  }

  const apiKey = cgApiKey ?? null;
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
      await new Promise((r) => setTimeout(r, RATE_LIMITS.COINGECKO_BACKFILL_MS));
    }

    try {
      // Fetch historical prices + market caps from CoinGecko
      const cgResult = await fetchJsonWithRetry<{
        prices: [number, number][];
        market_caps: [number, number][];
      }>(
        cgUrl(`/coins/${meta.geckoId}/market_chart?vs_currency=usd&days=max`, apiKey),
        { headers: cgHeaders({ "User-Agent": USER_AGENT }, apiKey) },
        2,
        { timeoutMs: 30_000 },
      );

      if (!cgResult) {
        errors.push(`${meta.symbol}: CoinGecko fetch failed (geckoId=${meta.geckoId})`);
        continue;
      }

      const cgData = cgResult.body;

      const cgPrices = cgData.prices ?? [];
      const cgMarketCaps = cgData.market_caps ?? [];
      const seedCoinGeckoPrices: PricePoint[] = cgPrices
        .filter(([, price]) => price > 0)
        .map(([ts, price]) => ({ timestamp: Math.floor(ts / 1000), price }));
      const priceSeries = await fetchMarketBackfillPriceSeries(meta, meta.geckoId, {
        granularity: "daily",
        seedCoinGeckoPrices,
      });
      const mergedPrices = priceSeries.prices ?? [];

      if (mergedPrices.length === 0) {
        skipped.push(`${meta.symbol} (no historical market price data)`);
        continue;
      }

      // Build maps: date -> price, date -> market_cap (normalized to UTC midnight)
      const priceByDate = new Map<number, number>();
      for (const point of mergedPrices) {
        const snapshotDate = Math.floor(point.timestamp / DAY_SECONDS) * DAY_SECONDS;
        priceByDate.set(snapshotDate, point.price);
      }

      const mcapByDate = new Map<number, number>();
      for (const [ts, mcap] of cgMarketCaps) {
        if (mcap <= 0) continue;
        const snapshotDate = Math.floor(ts / 1000 / DAY_SECONDS) * DAY_SECONDS;
        mcapByDate.set(snapshotDate, mcap);
      }

      // Query existing rows for this coin
      const existing = await db
        .prepare("SELECT snapshot_date, price, circulating_usd FROM supply_history WHERE stablecoin_id = ?")
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
          // Existing row with NULL price -> fill it
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
          // Existing row with price -> skip (preserve DL data)
        } else {
          // No existing row -> insert with market cap if available
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
        diagnostics: priceSeries.diagnostics,
      });
    } catch (err) {
      errors.push(`${meta.symbol}: ${err}`);
    }
  }

  return jsonResponse({
    coinsProcessed: coinDetails.length,
    totalPricesFilled,
    totalRowsInserted,
    coinDetails: coinDetails.length > 0 ? coinDetails : undefined,
    skipped: skipped.length > 0 ? skipped : undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export function handleBackfillCgPricesTrusted({
  db,
  url,
  coingeckoApiKey,
}: BackfillCgPricesRouteContext): Promise<Response> {
  return executeBackfillCgPrices(db, url, coingeckoApiKey);
}

export async function handleBackfillCgPrices(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
  cgApiKey?: string | null,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "backfill-cg-prices",
      request,
      trustedAdmin,
    },
    () => executeBackfillCgPrices(db, url, cgApiKey),
  );
}
