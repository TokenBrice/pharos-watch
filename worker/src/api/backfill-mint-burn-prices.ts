import { jsonResponse } from "../lib/api-utils";
import { batchExecute } from "../lib/db";
import { loadMintBurnPriceHistoryBatch, findMintBurnHistoricalPrice } from "../lib/mint-burn-pipeline/context";
import { rebuildHourlyForStablecoinIds } from "../lib/mint-burn-pipeline/persistence";
import { runAdminRoute } from "../lib/route-wrappers";

interface CoinRepairSummary {
  id: string;
  updated: number;
  valued: number;
  audited: number;
  stillUnpriced: number;
  stillMissingAudit: number;
}

function hasMissingAudit(row: {
  price_used: number | null;
  price_timestamp: number | null;
  price_source: string | null;
}): boolean {
  return row.price_used == null || row.price_timestamp == null || row.price_source == null;
}

function approxEqual(a: number, b: number): boolean {
  const tolerance = Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);
  return Math.abs(a - b) <= tolerance;
}

export async function handleBackfillMintBurnPrices(
  db: D1Database,
  _url: URL,
  trustedAdmin: boolean | undefined,
  request?: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "backfill-mint-burn-prices",
      request,
      trustedAdmin,
    },
    async () => {
      const needsRepairWhere =
        "(amount_usd IS NULL OR price_used IS NULL OR price_timestamp IS NULL OR price_source IS NULL)" as const;

      const incompleteRowsResult = await db
        .prepare(
          `SELECT id, stablecoin_id, chain_id, amount, amount_usd, timestamp, price_used, price_timestamp, price_source
           FROM mint_burn_events
           WHERE ${needsRepairWhere}
           ORDER BY stablecoin_id ASC, timestamp DESC, id DESC`,
        )
        .all<{
          id: string;
          stablecoin_id: string;
          chain_id: string;
          amount: number;
          amount_usd: number | null;
          timestamp: number;
          price_used: number | null;
          price_timestamp: number | null;
          price_source: string | null;
        }>();
      const incompleteRows = incompleteRowsResult.results ?? [];
      if (incompleteRows.length === 0) {
        return jsonResponse({
          totalUpdated: 0,
          rowsValued: 0,
          rowsAudited: 0,
          rowsStillUnpriced: 0,
          rowsStillMissingAudit: 0,
          coins: [],
        });
      }

      const stablecoinIds = [...new Set(incompleteRows.map((row) => row.stablecoin_id))];
      const priceHistory = await loadMintBurnPriceHistoryBatch(db, stablecoinIds);
      const updates = [];
      const affectedCoinsForHourlyRebuild = new Set<string>();
      const coinStats = new Map<string, CoinRepairSummary>();
      let rowsValued = 0;
      let rowsAudited = 0;
      let rowsStillUnpriced = 0;
      let rowsStillMissingAudit = 0;

      for (const row of incompleteRows) {
        const coin = coinStats.get(row.stablecoin_id) ?? {
          id: row.stablecoin_id,
          updated: 0,
          valued: 0,
          audited: 0,
          stillUnpriced: 0,
          stillMissingAudit: 0,
        };

        const historical = findMintBurnHistoricalPrice(priceHistory, row.stablecoin_id, row.timestamp);
        const derivedPriceUsed = row.amount_usd != null && row.amount > 0
          ? row.amount_usd / row.amount
          : null;

        if (row.amount_usd == null) {
          if (historical) {
            updates.push(
              db.prepare(
                `UPDATE mint_burn_events
                 SET amount_usd = ?, price_used = ?, price_timestamp = ?, price_source = ?
                 WHERE id = ?`,
              ).bind(
                row.amount * historical.price,
                historical.price,
                historical.snapshotDate,
                "backfill-supply-history-daily",
                row.id,
              ),
            );
            rowsValued++;
            coin.updated++;
            coin.valued++;
            affectedCoinsForHourlyRebuild.add(row.stablecoin_id);
          } else {
            rowsStillUnpriced++;
            coin.stillUnpriced++;
          }
          coinStats.set(row.stablecoin_id, coin);
          continue;
        }

        let auditUpdate: D1PreparedStatement | null = null;
        if (historical && derivedPriceUsed != null && approxEqual(derivedPriceUsed, historical.price)) {
          auditUpdate = db.prepare(
            `UPDATE mint_burn_events
             SET price_used = ?, price_timestamp = ?, price_source = ?
             WHERE id = ?`,
          ).bind(
            historical.price,
            historical.snapshotDate,
            "backfill-supply-history-daily",
            row.id,
          );
        } else if (derivedPriceUsed != null && row.price_source == null) {
          auditUpdate = db.prepare(
            `UPDATE mint_burn_events
             SET price_used = ?, price_source = ?
             WHERE id = ?`,
          ).bind(
            derivedPriceUsed,
            "backfill-derived-amount-usd",
            row.id,
          );
        } else if (derivedPriceUsed != null && row.price_used == null) {
          auditUpdate = db.prepare(
            `UPDATE mint_burn_events
             SET price_used = ?
             WHERE id = ?`,
          ).bind(
            derivedPriceUsed,
            row.id,
          );
        }

        if (auditUpdate) {
          updates.push(auditUpdate);
          rowsAudited++;
          coin.updated++;
          coin.audited++;
          const missingAfterAudit = hasMissingAudit({
            price_used: derivedPriceUsed ?? row.price_used,
            price_timestamp: historical && derivedPriceUsed != null && approxEqual(derivedPriceUsed, historical.price)
              ? historical.snapshotDate
              : row.price_timestamp,
            price_source: row.price_source
              ?? (derivedPriceUsed != null ? (historical && approxEqual(derivedPriceUsed, historical.price)
                ? "backfill-supply-history-daily"
                : "backfill-derived-amount-usd") : null),
          });
          if (missingAfterAudit) {
            rowsStillMissingAudit++;
            coin.stillMissingAudit++;
          }
        } else if (hasMissingAudit(row)) {
          rowsStillMissingAudit++;
          coin.stillMissingAudit++;
        }

        coinStats.set(row.stablecoin_id, coin);
      }

      const totalUpdated = updates.length > 0 ? await batchExecute(db, updates) : 0;

      if (affectedCoinsForHourlyRebuild.size > 0) {
        await rebuildHourlyForStablecoinIds(db, affectedCoinsForHourlyRebuild);
      }

      return jsonResponse({
        totalUpdated,
        rowsValued,
        rowsAudited,
        rowsStillUnpriced,
        rowsStillMissingAudit,
        coins: [...coinStats.values()].sort((a, b) => a.id.localeCompare(b.id)),
      });
    },
  );
}
