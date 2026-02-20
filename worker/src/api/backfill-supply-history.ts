import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { DEFILLAMA_BASE, USER_AGENT } from "../lib/constants";
import { batchExecute } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";
import { timingSafeEqual } from "../lib/auth";

const DEFAULT_BATCH_SIZE = 10;

interface TokenEntry {
  date: number; // unix seconds
  circulating?: Record<string, number>;
}

interface StablecoinDetail {
  tokens?: TokenEntry[];
}

export const handleBackfillSupplyHistory = withErrorHandler(
  "backfill-supply-history",
  async (
    db: D1Database,
    url: URL,
    adminSecret?: string,
    request?: Request,
  ): Promise<Response> => {
    const adminKey = request?.headers.get("X-Admin-Key");
    if (
      !adminSecret ||
      !adminKey ||
      !(await timingSafeEqual(adminKey, adminSecret))
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

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
      // Skip non-DefiLlama coins (no historical data available)
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
