import { withErrorHandler, errorResponse, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { computeStabilityIndex } from "../lib/stability-index";
import { batchExecute } from "../lib/db";
import { getPsiMethodologyVersionAt } from "@shared/lib/stability-index-version";
import {
  buildStabilityInputForDay,
  buildSupplySnapshotMap,
  type PsiDepegEventRow,
  type PsiSupplyRow,
} from "../lib/psi-recompute";

export const handleBackfillStabilityIndex = withErrorHandler(
  "backfill-stability-index",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    return withAdmin(request, adminKey, async () => {
      const now = Math.floor(Date.now() / 1000);
      const DAY = 86400;

      // Determine backfill window: find earliest depeg event
      const earliest = await db
        .prepare("SELECT MIN(started_at) as earliest FROM depeg_events")
        .first<{ earliest: number | null }>();

      if (!earliest?.earliest) {
        return errorResponse(404, "No depeg events found");
      }

      // Start from earliest depeg event, iterate day by day
      const startDay = Math.floor(earliest.earliest / DAY) * DAY;
      const endDay = Math.floor(now / DAY) * DAY;

      // Load all depeg events into memory for fast lookup
      const allDepegs = await db
        .prepare("SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at")
        .all<PsiDepegEventRow>();
      const depegEvents = allDepegs.results ?? [];

      // Load all supply snapshots for mcap lookup
      const allSupply = await db
        .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
        .all<PsiSupplyRow>();
      const supplyByCoin = buildSupplySnapshotMap(allSupply.results ?? []);

      await db.exec("DROP TABLE IF EXISTS stability_index_rebuild");
      await db.exec(`
        CREATE TABLE stability_index_rebuild (
          computed_at INTEGER PRIMARY KEY,
          score REAL NOT NULL,
          band TEXT NOT NULL,
          components TEXT NOT NULL,
          input_snapshot TEXT NOT NULL,
          methodology_version TEXT NOT NULL
        )
      `);

      // Iterate day by day — build all statements first, then atomically swap
      const stmts: D1PreparedStatement[] = [];
      let count = 0;
      let skippedInsufficientData = 0;

      for (let day = startDay; day <= endDay; day += DAY) {
        const input = buildStabilityInputForDay(day, now, depegEvents, supplyByCoin);
        const result = computeStabilityIndex({
          depegs: input.depegs,
          totalMcapUsd: input.totalMcapUsd,
          mcap7dChangePct: input.mcap7dChangePct,
        });
        if (!result) {
          skippedInsufficientData++;
          continue;
        }
        const methodologyVersion = getPsiMethodologyVersionAt(day);

        stmts.push(
          db.prepare(
            "INSERT INTO stability_index_rebuild (computed_at, score, band, components, input_snapshot, methodology_version) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(
            day,
            result.score,
            result.band,
            JSON.stringify(result.components),
            JSON.stringify({
              depegCount: input.depegCount,
              totalMcapUsd: input.totalMcapUsd,
              mcap7dChangePct: input.mcap7dChangePct,
              methodologyVersion,
            }),
            methodologyVersion,
          )
        );
        count++;
      }

      await batchExecute(db, stmts);

      try {
        // D1 in Workers rejects manual SQL transaction statements.
        // Use a single batch so DELETE + INSERT swap stays atomic.
        await db.batch([
          db.prepare("DELETE FROM stability_index"),
          db.prepare(
            `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
             SELECT computed_at, score, band, components, input_snapshot, methodology_version
             FROM stability_index_rebuild
             ORDER BY computed_at`
          ),
        ]);
      } finally {
        await db.exec("DROP TABLE IF EXISTS stability_index_rebuild").catch(() => {});
      }

      return jsonResponse({ ok: true, daysBackfilled: count, skippedInsufficientData });
    });
  }
);
