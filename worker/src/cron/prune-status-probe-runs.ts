import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { createCronResult } from "../lib/cron-result";
import { runWithOverloadRetry } from "../lib/cron-lease";

/**
 * Delete rows from `status_probe_runs` older than `cutoffSec`, capped at
 * `batchSize` rows per call. We subselect the oldest eligible ids via
 * `ORDER BY created_at ASC LIMIT ?` so each statement stays within D1's
 * 30-second per-statement budget even if the backlog is large.
 */
export async function pruneStatusProbeRuns(
  db: D1Database,
  opts: { cutoffSec: number; batchSize: number; signal?: AbortSignal },
): Promise<{ deleted: number }> {
  const res = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          "DELETE FROM status_probe_runs WHERE created_at < ? AND id IN (SELECT id FROM status_probe_runs WHERE created_at < ? ORDER BY created_at ASC LIMIT ?)",
        )
        .bind(opts.cutoffSec, opts.cutoffSec, opts.batchSize)
        .run(),
    3,
    opts.signal,
  );
  return { deleted: res.meta?.changes ?? 0 };
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
