/**
 * project-tape: read each v1 source since its per-class watermark and project
 * new rows into `tape_events`. Idempotent on `(source_table, source_row_id,
 * transition)` so re-running the job is a no-op for rows already projected.
 *
 * `TAPE_PROJECTOR_JOBS` in `worker/src/lib/tape-projectors/registry.ts` is the
 * ordered class authority; do not copy its roster into this header. Classes are
 * three shapes: explicit transition tables (depeg_events, blacklist_events,
 * safety_grade_history, mint_burn_events), snapshot tables diffed in JS against
 * the last sample at or before the watermark (stability_index_samples,
 * stress_signals, yield_history and yield_source_decisions), and
 * first-observation static catalogs (methodology `*-version` changelogs,
 * cemetery entries, frozen stablecoins).
 *
 * Runs on the `26,56 * * * *` DEWS/PSI lane. Projection is D1-only;
 * the placed-fetch canary driver separately reserves one service-binding call.
 */
import { recordCronFailure, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { TAPE_PROJECTOR_JOBS } from "../lib/tape-projectors/registry";
import { throwIfAborted } from "../lib/abort";
import { createD1CostTracker } from "../lib/d1-cost";

export async function projectTape(
  db: D1Database,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const d1Cost = createD1CostTracker(db, ["outer-cron-lifecycle-excluded"]);
  db = d1Cost.db;
  const perClass: Record<string, number> = {};
  let total = 0;
  let advancedAny = false;
  const startedMs = Date.now();
  const publishProgress = async (
    stage: string,
    className: string | null,
    index: number,
    projected?: number,
  ): Promise<void> => {
    if (!reportProgress) return;
    await reportProgress({
      stage,
      itemsDone: index,
      itemsTotal: TAPE_PROJECTOR_JOBS.length,
      message: className ? `Projecting tape ${className}` : "Projecting tape",
      metadata: {
        currentClass: className,
        projected,
        totalProjected: total,
        elapsedMs: Date.now() - startedMs,
      },
    });
  };

  // Serialize classes to keep the run cheap on D1 and zero outbound
  // connections; the projector shares the 26,56 lane with compute-dews and
  // stability-index.
  for (let index = 0; index < TAPE_PROJECTOR_JOBS.length; index++) {
    const job = TAPE_PROJECTOR_JOBS[index]!;
    throwIfAborted(signal);
    await publishProgress("projecting-class", job.name, index);
    try {
      const result = await job.run(db);
      perClass[job.name] = result.projected;
      total += result.projected;
      if (result.advanced != null) advancedAny = true;
      await publishProgress("projected-class", job.name, index + 1, result.projected);
    } catch (err) {
      recordCronFailure("project-tape", err, { metadata: { class: job.name } });
      perClass[job.name] = -1;
      await publishProgress("projected-class-error", job.name, index + 1, -1);
    }
  }

  const hasFailure = Object.values(perClass).some((projected) => projected === -1);
  return {
    status: hasFailure ? "degraded" : "ok",
    itemCount: total,
    productivity: { productive: total > 0 },
    metadata: JSON.stringify({ reason: hasFailure ? "tape-projector-failed" : "tape-projection-completed", perClass, watermarkAdvanced: advancedAny, d1Cost: d1Cost.snapshot() }),
  };
}
