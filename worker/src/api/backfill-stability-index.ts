import { errorResponse, jsonResponse } from "../lib/api-response";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { batchExecute } from "../lib/db";
import { getPsiMethodologyVersionAt } from "@shared/lib/methodology-versions/stability-index";
import { buildSupplySnapshotMap, type PsiDepegEventRow, type PsiSupplyRow } from "../lib/psi-recompute";
import {
  buildHistoricalDewsMap,
  replayHistoricalPsiForDay,
  type PsiHistoricalDewsRow,
  usesHistoricalStressBreadth,
} from "../lib/psi-replay";
import type { PsiUniverseCache } from "../lib/psi-history-universe";
import { runAdminJob } from "../lib/admin-job";
import { acquireCronLease, createLeaseOwner, releaseCronLease, renewCronLease } from "../lib/cron-lease-primitives";
import { logWorkerEvent } from "../lib/structured-log";
import { parseOptionalDayWindow } from "./backfill-depegs-window";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE } from "@shared/lib/stablecoins/aggregate-universe";

// Advisory lease key fencing concurrent admin invocations of this rebuild. It
// is intentionally distinct from the "stability-index" cron job key.
const BACKFILL_PSI_LEASE_JOB = "backfill-stability-index";
const BACKFILL_PSI_LEASE_TTL_SEC = 10 * 60;
const BACKFILL_PSI_LEASE_HEARTBEAT_SEC = 60;

interface ExistingStabilityIndexRow {
  computed_at: number;
  score: number;
  band: string;
  components: string | null;
  input_snapshot: string | null;
  methodology_version: string | null;
}

export interface BackfillStabilityIndexRouteContext {
  db: D1Database;
  url: URL;
  trustedAdmin?: boolean;
  request?: Request;
}

export async function handleBackfillStabilityIndex({
  db,
  url,
  request,
}: BackfillStabilityIndexRouteContext): Promise<Response> {
  return runAdminJob({ request, url }, async ({ dryRun }) => {
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
    const todayMidnight = bucketUnixSecondsToUtcDay(now);

    // Determine backfill window: find earliest depeg event
    const earliest = await db
      .prepare("SELECT MIN(started_at) as earliest FROM depeg_events")
      .first<{ earliest: number | null }>();

    if (!earliest?.earliest) {
      return errorResponse(404, "No depeg events found");
    }

    // Start from earliest depeg event, iterate day by day
    const earliestDay = bucketUnixSecondsToUtcDay(earliest.earliest);
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
      : db.prepare("SELECT stablecoin_id, snapshot_date, band FROM stress_signal_history ORDER BY snapshot_date");
    const allHistoricalDews = await dewsQuery.all<PsiHistoricalDewsRow>();
    const dewsByDay = buildHistoricalDewsMap(allHistoricalDews.results ?? []);

    const existingRows = await db
      .prepare(
        "SELECT computed_at, score, band, components, input_snapshot, methodology_version FROM stability_index WHERE computed_at >= ? AND computed_at <= ?",
      )
      .bind(startDay, endDay)
      .all<ExistingStabilityIndexRow>();
    const existingByDay = new Map((existingRows.results ?? []).map((row) => [row.computed_at, row]));

    // Fence concurrent non-dry-run rebuilds: two overlapping admin calls would
    // otherwise DROP each other's rebuild table or interleave the canonical
    // DELETE+INSERT swap, risking a partial or empty stability_index.
    const leaseOwner = createLeaseOwner(BACKFILL_PSI_LEASE_JOB);
    let leaseAcquired = false;
    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    let leaseRenewalInFlight: Promise<boolean> | undefined;
    let leaseLost = false;
    let scratchCleanupRequired = false;

    const renewAdvisoryLease = async (reason: "heartbeat" | "pre-swap"): Promise<boolean> => {
      try {
        const renewed = await renewCronLease(db, BACKFILL_PSI_LEASE_JOB, leaseOwner, BACKFILL_PSI_LEASE_TTL_SEC);
        if (renewed) return true;

        leaseLost = true;
        logWorkerEvent({
          scope: "admin",
          level: "error",
          event: "backfill_stability_index_lease_lost",
          route: BACKFILL_PSI_LEASE_JOB,
          source: "cron_leases",
          message: "Stability-index backfill advisory lease ownership was lost",
          metadata: { reason },
        });
        return false;
      } catch (error) {
        leaseLost = true;
        logWorkerEvent({
          scope: "admin",
          level: "error",
          event: "backfill_stability_index_lease_renew_failed",
          route: BACKFILL_PSI_LEASE_JOB,
          source: "cron_leases",
          message: "Stability-index backfill advisory lease renewal failed",
          error,
          metadata: { reason },
        });
        return false;
      }
    };

    if (!dryRun) {
      leaseAcquired = await acquireCronLease(db, BACKFILL_PSI_LEASE_JOB, leaseOwner, BACKFILL_PSI_LEASE_TTL_SEC);
      if (!leaseAcquired) {
        return errorResponse(409, "A stability-index backfill is already running. Try again later.");
      }
      leaseHeartbeat = setInterval(() => {
        if (leaseRenewalInFlight) return;
        leaseRenewalInFlight = renewAdvisoryLease("heartbeat").finally(() => {
          leaseRenewalInFlight = undefined;
        });
      }, BACKFILL_PSI_LEASE_HEARTBEAT_SEC * 1000);
    }

    try {
      if (!dryRun) {
        scratchCleanupRequired = true;
        await db.batch([db.prepare("DROP TABLE IF EXISTS stability_index_rebuild"), db.prepare(rebuildTableSql)]);
      }

      // Iterate day by day — build all statements first, then atomically swap
      const stmts: D1PreparedStatement[] = [];
      let count = 0;
      let skippedInsufficientData = 0;
      let daysEvaluated = 0;
      let daysChanged = 0;
      let maxAbsoluteScoreDelta = 0;
      const universeCache: PsiUniverseCache = new Map();

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
          universeCache,
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
        if (
          !existing ||
          existing.band !== result.band ||
          existing.methodology_version !== methodologyVersion ||
          absoluteDelta > 0.0001
        ) {
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
                  aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
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

      if (leaseHeartbeat) {
        clearInterval(leaseHeartbeat);
        leaseHeartbeat = undefined;
      }
      if (leaseRenewalInFlight) {
        await leaseRenewalInFlight;
      }
      const leaseAuthoritativelyRenewed = !leaseLost && (await renewAdvisoryLease("pre-swap"));
      if (!leaseAuthoritativelyRenewed) {
        return errorResponse(409, "Stability-index backfill lease was lost; canonical data was not changed.");
      }

      // D1 in Workers rejects manual SQL transaction statements.
      // Use a single batch so the final swap stays atomic for either the full table or the requested range.
      if (hasExplicitWindow) {
        await db.batch([
          db.prepare("DELETE FROM stability_index WHERE computed_at >= ? AND computed_at <= ?").bind(startDay, endDay),
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
    } finally {
      if (leaseHeartbeat) {
        clearInterval(leaseHeartbeat);
      }
      if (leaseRenewalInFlight) {
        await leaseRenewalInFlight;
      }
      if (scratchCleanupRequired && leaseLost) {
        logWorkerEvent({
          scope: "admin",
          level: "warn",
          event: "backfill_stability_index_scratch_cleanup_deferred",
          route: BACKFILL_PSI_LEASE_JOB,
          source: "stability_index_rebuild",
          message: "Scratch cleanup was deferred after lease loss to avoid interfering with a successor",
        });
      } else if (scratchCleanupRequired) {
        try {
          await db.exec("DROP TABLE IF EXISTS stability_index_rebuild");
        } catch (error) {
          logWorkerEvent({
            scope: "admin",
            level: "error",
            event: "backfill_stability_index_scratch_cleanup_failed",
            route: BACKFILL_PSI_LEASE_JOB,
            source: "stability_index_rebuild",
            message: "Failed to clean up the stability-index backfill scratch table",
            error,
          });
        }
      }
      if (leaseAcquired) {
        try {
          await releaseCronLease(db, BACKFILL_PSI_LEASE_JOB, leaseOwner);
        } catch (error) {
          logWorkerEvent({
            scope: "admin",
            level: "warn",
            event: "backfill_stability_index_lease_release_failed",
            route: BACKFILL_PSI_LEASE_JOB,
            source: "cron_leases",
            message: "Failed to release the stability-index backfill advisory lease",
            error,
          });
        }
      }
    }
  });
}
