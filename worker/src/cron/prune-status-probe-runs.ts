import type { CronResult } from "../lib/cron-logger";

/**
 * Delete rows from `status_probe_runs` older than `cutoffSec`, capped at
 * `batchSize` rows per call. We subselect the oldest eligible ids via
 * `ORDER BY created_at ASC LIMIT ?` so each statement stays within D1's
 * 30-second per-statement budget even if the backlog is large.
 */
export async function pruneStatusProbeRuns(
  db: D1Database,
  opts: { cutoffSec: number; batchSize: number },
): Promise<{ deleted: number }> {
  const res = await db
    .prepare(
      "DELETE FROM status_probe_runs WHERE created_at < ? AND id IN (SELECT id FROM status_probe_runs WHERE created_at < ? ORDER BY created_at ASC LIMIT ?)",
    )
    .bind(opts.cutoffSec, opts.cutoffSec, opts.batchSize)
    .run();
  return { deleted: res.meta?.changes ?? 0 };
}

export async function runPruneStatusProbeRuns(db: D1Database): Promise<CronResult> {
  const cutoffSec = Math.floor(Date.now() / 1000) - 90 * 86_400;
  const { deleted } = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 10_000 });
  return {
    status: "ok",
    itemCount: deleted,
    metadata: JSON.stringify({ cutoffSec, deleted }),
  };
}
