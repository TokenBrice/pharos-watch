import { requireAdmin } from "../lib/auth";
import { withErrorHandler } from "../lib/api-utils";
import { getPriceCache, batchExecute } from "../lib/db";

export const handleBackfillMintBurnPrices = withErrorHandler(
  "backfill-mint-burn-prices",
  async (db: D1Database, _url: URL, adminKey: string | undefined, request?: Request): Promise<Response> => {
    const authErr = await requireAdmin(request, adminKey);
    if (authErr) return authErr;

    // 1. Load current prices
    const priceCache = await getPriceCache(db);

    // 2. Find distinct stablecoin_ids with NULL amount_usd
    const nullRows = await db
      .prepare("SELECT DISTINCT stablecoin_id FROM mint_burn_events WHERE amount_usd IS NULL")
      .all<{ stablecoin_id: string }>();

    let totalUpdated = 0;
    const coinResults: Array<{ id: string; updated: number }> = [];

    for (const { stablecoin_id } of nullRows.results ?? []) {
      const cached = priceCache.get(stablecoin_id);
      if (!cached) {
        coinResults.push({ id: stablecoin_id, updated: 0 });
        continue;
      }

      // 3. Update amount_usd = amount * price for all NULL rows of this coin
      const result = await db
        .prepare(
          "UPDATE mint_burn_events SET amount_usd = amount * ? WHERE stablecoin_id = ? AND amount_usd IS NULL"
        )
        .bind(cached.price, stablecoin_id)
        .run();

      const updated = result.meta?.changes ?? 0;
      totalUpdated += updated;
      coinResults.push({ id: stablecoin_id, updated });
    }

    // 4. Recalculate ALL hourly buckets for affected coins
    if (totalUpdated > 0) {
      const affectedIds = coinResults.filter((c) => c.updated > 0).map((c) => c.id);

      // Delete existing hourly rows for affected coins, then re-aggregate
      const deleteStmts = affectedIds.map((id) =>
        db.prepare("DELETE FROM mint_burn_hourly WHERE stablecoin_id = ?").bind(id)
      );
      await batchExecute(db, deleteStmts);

      const insertStmts = affectedIds.map((id) =>
        db.prepare(`
          INSERT OR REPLACE INTO mint_burn_hourly
            (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
             mint_volume_usd, burn_volume_usd, net_flow_usd)
          SELECT
            stablecoin_id, chain_id,
            (timestamp / 3600) * 3600 AS hour_ts,
            SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
            SUM(CASE WHEN direction = 'burn' THEN 1 ELSE 0 END),
            COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN direction = 'burn' THEN amount_usd ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE -amount_usd END), 0)
          FROM mint_burn_events
          WHERE stablecoin_id = ?
          GROUP BY stablecoin_id, chain_id, hour_ts
        `).bind(id)
      );
      await batchExecute(db, insertStmts);
    }

    return new Response(
      JSON.stringify({ totalUpdated, coins: coinResults }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
);
