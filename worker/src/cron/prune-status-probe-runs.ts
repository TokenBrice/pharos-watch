import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { createCronResult } from "../lib/cron-result";
import { deleteCapped } from "./shared/capped-delete";

/**
 * Delete rows from `status_probe_runs` older than `cutoffSec`, capped at
 * `batchSize` rows per call. We subselect the oldest eligible ids via
 * `ORDER BY created_at ASC LIMIT ?` so each statement stays within D1's
 * 30-second per-statement budget even if the backlog is large. Batch limit and
 * run budget are the same number here: one statement per call, by design.
 */
export async function pruneStatusProbeRuns(
  db: D1Database,
  opts: { cutoffSec: number; batchSize: number; signal?: AbortSignal },
): Promise<{ deleted: number }> {
  const { pruned } = await deleteCapped(
    db,
    "DELETE FROM status_probe_runs WHERE created_at < ? AND id IN (SELECT id FROM status_probe_runs WHERE created_at < ? ORDER BY created_at ASC LIMIT ?)",
    (limit) => [opts.cutoffSec, opts.cutoffSec, limit],
    opts.batchSize,
    opts.batchSize,
    opts.signal,
  );
  return { deleted: pruned };
}

export async function runPruneStatusProbeRuns(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const cutoffSec = Math.floor(Date.now() / 1000) - 90 * 86_400;
  const { deleted } = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 10_000, signal });
  throwIfAborted(signal);
  return createCronResult({
    status: "ok",
    itemCount: deleted,
    metadata: { cutoffSec, deleted },
  });
}
