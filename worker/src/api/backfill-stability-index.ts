import { errorResponse, jsonResponse } from "../lib/api-utils";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { batchExecute } from "../lib/db";
import { getPsiMethodologyVersionAt } from "@shared/lib/stability-index-version";
import {
  buildSupplySnapshotMap,
  type PsiDepegEventRow,
  type PsiSupplyRow,
} from "../lib/psi-recompute";
import {
  buildHistoricalDewsMap,
  replayHistoricalPsiForDay,
  type PsiHistoricalDewsRow,
  usesHistoricalStressBreadth,
} from "../lib/psi-replay";
import { runAdminJob } from "../lib/admin-job";
import { parseOptionalDayWindow } from "./backfill-depegs-window";

interface ExistingStabilityIndexRow {
  computed_at: number;
  score: number;
  band: string;
  components: string | null;
  input_snapshot: string | null;
  methodology_version: string | null;
}

export async function handleBackfillStabilityIndex(
  db: D1Database,
  trustedAdmin?: boolean,
  request?: Request,
): Promise<Response> {
  const url = request ? new URL(request.url) : new URL("https://api.pharos.watch/api/backfill-stability-index");

  return runAdminJob(
    { request, trustedAdmin, url },
    async ({ dryRun }) => {
      const rebuildTableSql = [
        "CREATE TABLE stability_index_rebuild (",
        "computed_at INTEGER PRIMARY KEY,",
        "score REAL NOT NULL,",
        "band TEXT NOT NULL,",
        "components TEXT NOT NULL,",
        "input_snapshot TEXT NOT NULL,",
        "methodology_version TEXT NOT NULL",
        ")",
      ].join(" ");

      const now = Math.floor(Date.now() / 1000);
      const todayMidnight = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;

      // Determine backfill window: find earliest depeg event
      const earliest = await db
        .prepare("SELECT MIN(started_at) as earliest FROM depeg_events")
        .first<{ earliest: number | null }>();

      if (!earliest?.earliest) {
        return errorResponse(404, "No depeg events found");
      }

      // Start from earliest depeg event, iterate day by day
      const earliestDay = Math.floor(earliest.earliest / DAY_SECONDS) * DAY_SECONDS;
      const latestCompletedDay = todayMidnight - DAY_SECONDS;
      const window = parseOptionalDayWindow(url, {
        defaultStartDay: earliestDay,
        defaultEndDay: latestCompletedDay,
        minStartDay: earliestDay,
        maxEndDay: latestCompletedDay,
        rejectInvertedRange: false,
      });
      if (window instanceof Response) return window;
      const { startDay, endDay, hasExplicitWindow } = window;

      if (startDay == null || endDay == null || startDay > endDay) {
        return jsonResponse({
          ok: true,
          dryRun,
          daysBackfilled: 0,
          daysEvaluated: 0,
          daysChanged: 0,
          skippedInsufficientData: 0,
          maxAbsoluteScoreDelta: 0,
          startDay,
          endDay,
          reason: "no-completed-utc-days",
        });
      }

      const supplyQueryStartDay = Math.max(0, startDay - 7 * DAY_SECONDS);

      const depegQuery = hasExplicitWindow
        ? db
          .prepare(
            `SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at
             FROM depeg_events
             WHERE started_at <= ? AND (ended_at IS NULL OR ended_at > ?)
             ORDER BY started_at`,
          )
          .bind(endDay, startDay)
        : db.prepare(
          "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events ORDER BY started_at",
        );

      const allDepegs = await depegQuery.all<PsiDepegEventRow>();
      const depegEvents = allDepegs.results ?? [];

      const supplyQuery = hasExplicitWindow
        ? db
          .prepare(
            `SELECT stablecoin_id, snapshot_date, circulating_usd, price
             FROM supply_history
             WHERE snapshot_date >= ? AND snapshot_date <= ?
             ORDER BY snapshot_date`,
          )
          .bind(supplyQueryStartDay, endDay)
        : db.prepare(
          "SELECT stablecoin_id, snapshot_date, circulating_usd, price FROM supply_history ORDER BY snapshot_date",
        );
      const allSupply = await supplyQuery.all<PsiSupplyRow>();
      const supplyByCoin = buildSupplySnapshotMap(allSupply.results ?? []);

      const dewsQuery = hasExplicitWindow
        ? db
          .prepare(
            `SELECT stablecoin_id, snapshot_date, band
             FROM stress_signal_history
             WHERE snapshot_date >= ? AND snapshot_date <= ?
             ORDER BY snapshot_date`,
          )
          .bind(startDay, endDay)
        : db.prepare(
          "SELECT stablecoin_id, snapshot_date, band FROM stress_signal_history ORDER BY snapshot_date",
        );
      const allHistoricalDews = await dewsQuery.all<PsiHistoricalDewsRow>();
      const dewsByDay = buildHistoricalDewsMap(allHistoricalDews.results ?? []);

      const existingRows = await db
        .prepare(
          "SELECT computed_at, score, band, components, input_snapshot, methodology_version FROM stability_index WHERE computed_at >= ? AND computed_at <= ?",
        )
        .bind(startDay, endDay)
        .all<ExistingStabilityIndexRow>();
      const existingByDay = new Map((existingRows.results ?? []).map((row) => [row.computed_at, row]));

      if (!dryRun) {
        await db.batch([db.prepare("DROP TABLE IF EXISTS stability_index_rebuild"), db.prepare(rebuildTableSql)]);
      }

      // Iterate day by day — build all statements first, then atomically swap
      const stmts: D1PreparedStatement[] = [];
      let count = 0;
      let skippedInsufficientData = 0;
      let daysEvaluated = 0;
      let daysChanged = 0;
      let maxAbsoluteScoreDelta = 0;

      for (let day = startDay; day <= endDay; day += DAY_SECONDS) {
        daysEvaluated++;
        const methodologyVersion = getPsiMethodologyVersionAt(day);
        const replay = replayHistoricalPsiForDay({
          day,
          now,
          methodologyVersion,
          depegEvents,
          supplyByCoin,
          dewsByDay,
        });
        const { input, result } = replay;
        const existing = existingByDay.get(day);
        if (!result) {
          skippedInsufficientData++;
          if (!dryRun && existing) {
            stmts.push(
              db
                .prepare(
                  "INSERT INTO stability_index_rebuild (computed_at, score, band, components, input_snapshot, methodology_version) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(
                  existing.computed_at,
                  existing.score,
                  existing.band,
                  existing.components ?? JSON.stringify({}),
                  existing.input_snapshot ?? JSON.stringify({}),
                  existing.methodology_version ?? getPsiMethodologyVersionAt(existing.computed_at),
                ),
            );
          }
          continue;
        }

        const absoluteDelta = existing ? Math.abs(existing.score - result.score) : Math.abs(result.score);
        if (!existing || existing.band !== result.band || existing.methodology_version !== methodologyVersion || absoluteDelta > 0.0001) {
          daysChanged++;
        }
        if (absoluteDelta > maxAbsoluteScoreDelta) {
          maxAbsoluteScoreDelta = absoluteDelta;
        }

        if (!dryRun) {
          stmts.push(
            db
              .prepare(
                "INSERT INTO stability_index_rebuild (computed_at, score, band, components, input_snapshot, methodology_version) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .bind(
                day,
                result.score,
                result.band,
                JSON.stringify(result.components),
                JSON.stringify({
                  depegCount: input.depegCount,
                  totalMcapUsd: input.totalMcapUsd,
                  mcap7dChangePct: input.mcap7dChangePct,
                  eligibleUniverseCount: input.eligibleUniverseCount,
                  coveredUniverseCount: input.coveredUniverseCount,
                  shadowCoverageCount: input.shadowCoverageCount,
                  historicalPriceCoverageCount: input.historicalPriceCoverageCount,
                  peakDeviationFallbackCount: input.peakDeviationFallbackCount,
                  dewsStressBreadth: input.dewsStressBreadth ?? 0,
                  stressBreadthIncluded: usesHistoricalStressBreadth(methodologyVersion),
                  methodologyVersion,
                }),
                methodologyVersion,
              ),
          );
        }
        count++;
      }

      if (dryRun) {
        return jsonResponse({
          ok: true,
          dryRun,
          daysBackfilled: count,
          daysEvaluated,
          daysChanged,
          skippedInsufficientData,
          maxAbsoluteScoreDelta: Math.round(maxAbsoluteScoreDelta * 1000) / 1000,
          startDay,
          endDay,
        });
      }

      await batchExecute(db, stmts);

      try {
        // D1 in Workers rejects manual SQL transaction statements.
        // Use a single batch so the final swap stays atomic for either the full table or the requested range.
        if (hasExplicitWindow) {
          await db.batch([
            db
              .prepare("DELETE FROM stability_index WHERE computed_at >= ? AND computed_at <= ?")
              .bind(startDay, endDay),
            db
              .prepare(
                `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
                 SELECT computed_at, score, band, components, input_snapshot, methodology_version
                 FROM stability_index_rebuild
                 WHERE computed_at >= ? AND computed_at <= ?
                 ORDER BY computed_at`,
              )
              .bind(startDay, endDay),
          ]);
        } else {
          await db.batch([
            db.prepare("DELETE FROM stability_index"),
            db.prepare(
              `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
               SELECT computed_at, score, band, components, input_snapshot, methodology_version
               FROM stability_index_rebuild
               ORDER BY computed_at`,
            ),
          ]);
        }
      } finally {
        await db.exec("DROP TABLE IF EXISTS stability_index_rebuild").catch(() => {});
      }

      return jsonResponse({
        ok: true,
        dryRun,
        daysBackfilled: count,
        daysEvaluated,
        daysChanged,
        skippedInsufficientData,
        maxAbsoluteScoreDelta: Math.round(maxAbsoluteScoreDelta * 1000) / 1000,
        startDay,
        endDay,
      });
    },
  );
}
