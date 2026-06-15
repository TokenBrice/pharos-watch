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
import {
  projectDepegOpened,
  projectDepegPeakWorsened,
  projectDepegResolved,
} from "../lib/tape-projectors/depeg";
import {
  projectFreezeBlocked,
  projectFreezeDestroyed,
  projectFreezeUnblocked,
} from "../lib/tape-projectors/freeze";
import {
  projectScoreDowngraded,
  projectScoreUpgraded,
} from "../lib/tape-projectors/score";
import { projectMethodologyBumps } from "../lib/tape-projectors/methodology";
import { projectCemeteryEntries } from "../lib/tape-projectors/cemetery";
import { projectLifecycleFrozen } from "../lib/tape-projectors/lifecycle";
import { projectPsiBandShifts } from "../lib/tape-projectors/psi";
import { projectMintBurnLargeFlows } from "../lib/tape-projectors/mint-burn";
import { projectDewsEscalated, projectDewsDeescalated } from "../lib/tape-projectors/dews";
import { projectYieldWarningEmitted, projectYieldPysDropped } from "../lib/tape-projectors/yield";
import type { Projector } from "../lib/tape-projectors/types";

export interface ProjectTapeJob {
  name: string;
  run: Projector;
}

/**
 * Canonical ordered list of v1 projector jobs. Exposed so the backfill admin
 * endpoint can dispatch the same code path with operator-supplied overrides.
 */
export const TAPE_PROJECTOR_JOBS: readonly ProjectTapeJob[] = [
  { name: "depeg.opened",            run: projectDepegOpened },
  { name: "depeg.resolved",          run: projectDepegResolved },
  { name: "depeg.peak_worsened",     run: projectDepegPeakWorsened },
  { name: "freeze.blocked",          run: projectFreezeBlocked },
  { name: "freeze.unblocked",        run: projectFreezeUnblocked },
  { name: "freeze.destroyed",        run: projectFreezeDestroyed },
  { name: "score.upgraded",          run: projectScoreUpgraded },
  { name: "score.downgraded",        run: projectScoreDowngraded },
  { name: "psi.band_changed",        run: projectPsiBandShifts },
  { name: "dews.escalated",          run: projectDewsEscalated },
  { name: "dews.deescalated",        run: projectDewsDeescalated },
  { name: "mint_burn.large_flow",    run: projectMintBurnLargeFlows },
  { name: "yield.warning_emitted",   run: projectYieldWarningEmitted },
  { name: "yield.pys_dropped",       run: projectYieldPysDropped },
  { name: "methodology.bumped",      run: projectMethodologyBumps },
  { name: "cemetery.entry.added",    run: projectCemeteryEntries },
  { name: "lifecycle.tracked.frozen", run: projectLifecycleFrozen },
];

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
    if (signal?.aborted) throw signal.reason ?? new Error("project-tape aborted");
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
    metadata: JSON.stringify({ perClass, watermarkAdvanced: advancedAny }),
  };
}
