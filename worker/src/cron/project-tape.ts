/**
 * project-tape: read each v1 source since its per-class watermark and project
 * new rows into `tape_events`. Idempotent on `(source_table, source_row_id,
 * transition)` so re-running the job is a no-op for rows already projected.
 *
 * v1 scope (Phase 0):
 *   - depeg_events           → depeg.opened, depeg.resolved, depeg.peak_worsened
 *   - blacklist_events       → freeze.blocked, freeze.unblocked, freeze.destroyed
 *   - safety_grade_history   → score.upgraded, score.downgraded
 *   - shared/lib/*-version   → methodology.bumped:<domain>
 *   - shared/lib/cemetery-merged → cemetery.entry.added
 *   - shared/lib/stablecoins (frozen) → lifecycle.tracked.frozen
 *
 * The three relational sources are explicit transition tables (no snapshot
 * diff). The static sources use a first-observation pattern.
 *
 * Runs on the `26,56 * * * *` DEWS/PSI DB-only lane (purely D1-bound, no
 * outbound fetches), so it adds zero connection budget to the trigger.
 */
import { recordCronFailure, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { TAPE_PROJECTOR_JOBS } from "../lib/tape-projectors/registry";
import { throwIfAborted } from "../lib/abort";

export async function projectTape(
  db: D1Database,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
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
  return createCronResult({
    status: hasFailure ? "degraded" : "ok",
    itemCount: total,
    metadata: { perClass, watermarkAdvanced: advancedAny },
  });
}
