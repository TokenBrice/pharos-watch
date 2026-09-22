import { runBoundedPrune } from "./bounded-prune";

export const WORKER_CANARY_RUN_RETENTION_SEC = 14 * 24 * 3600;

export async function pruneWorkerCanaryRuns(
  db: D1Database,
  cutoffObservedAt: number,
  signal?: AbortSignal,
  limits: { batchLimit?: number; runLimit?: number } = {},
): Promise<{ deleted: number; truncated: boolean }> {
  const deleteSql = `DELETE FROM worker_canary_runs
    WHERE rowid IN (
      SELECT rowid FROM worker_canary_runs
      WHERE observed_at < ?
      ORDER BY observed_at ASC
      LIMIT ?
    )`;
  const batchLimit = limits.batchLimit ?? 5_000;
  const runLimit = limits.runLimit ?? 20_000;
  return runBoundedPrune({
    batchLimit,
    runLimit,
    signal,
    deleteBatch: (limit) => db.prepare(deleteSql).bind(cutoffObservedAt, limit).run(),
  });
}
