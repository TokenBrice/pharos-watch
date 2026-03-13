import { requireAdmin } from "../lib/auth";
import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { getPriceCache } from "../lib/db-cache";

export const handleBackfillMintBurnPrices = withErrorHandler(
  "backfill-mint-burn-prices",
  async (db: D1Database, _url: URL, trustedAdmin: boolean | undefined, request?: Request): Promise<Response> => {
    const authErr = await requireAdmin(request, trustedAdmin);
    if (authErr) return authErr;

    // 1. Load current prices
    const priceCache = await getPriceCache(db);
    // SAFETY: needsRepairWhere is a compile-time constant, not derived from user input.
    const needsRepairWhere = "(amount_usd IS NULL OR price_used IS NULL OR price_timestamp IS NULL OR price_source IS NULL)" as const;

    // 2. Find distinct stablecoin_ids with incomplete valuation/audit fields
    const nullRows = await db
      .prepare(`SELECT DISTINCT stablecoin_id FROM mint_burn_events WHERE ${needsRepairWhere}`)
      .all<{ stablecoin_id: string }>();

    let totalUpdated = 0;
    const coinResults: Array<{ id: string; updated: number }> = [];

    for (const { stablecoin_id } of nullRows.results ?? []) {
      const cached = priceCache.get(stablecoin_id);
      if (!cached) {
        coinResults.push({ id: stablecoin_id, updated: 0 });
        continue;
      }

      // 3. Repair valuation and audit fields for rows missing any required value
      const result = await db
        .prepare(
          `UPDATE mint_burn_events
           SET amount_usd = COALESCE(amount_usd, amount * ?),
               price_used = COALESCE(price_used, ?),
               price_timestamp = COALESCE(price_timestamp, ?),
               price_source = COALESCE(price_source, 'backfill-price-cache')
           WHERE stablecoin_id = ? AND ${needsRepairWhere}`
        )
        .bind(cached.price, cached.price, cached.updatedAt, stablecoin_id)
        .run();

      const updated = result.meta?.changes ?? 0;
      totalUpdated += updated;
      coinResults.push({ id: stablecoin_id, updated });
    }

    // 4. Recalculate ALL hourly buckets for affected coins
    if (totalUpdated > 0) {
      const affectedIds = coinResults.filter((c) => c.updated > 0).map((c) => c.id);

      // Rebuild each coin atomically (delete + insert in one batch).
      for (const id of affectedIds) {
        await db.batch([
          db.prepare("DELETE FROM mint_burn_hourly WHERE stablecoin_id = ?").bind(id),
          db.prepare(`
            INSERT OR REPLACE INTO mint_burn_hourly
              (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
               mint_volume_usd, burn_volume_usd, net_flow_usd)
            SELECT
              stablecoin_id, chain_id,
              (timestamp / 3600) * 3600 AS hour_ts,
              SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN 1 ELSE 0 END),
              SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN 1 ELSE 0 END),
              COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN amount_usd ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN direction = 'mint' AND flow_type = 'standard' THEN amount_usd WHEN direction = 'burn' AND burn_type = 'effective_burn' AND flow_type = 'standard' THEN -amount_usd ELSE 0 END), 0)
            FROM mint_burn_events
            WHERE stablecoin_id = ?
            GROUP BY stablecoin_id, chain_id, hour_ts
          `).bind(id),
        ]);
      }
    }

    return jsonResponse({ totalUpdated, coins: coinResults });
  }
);
