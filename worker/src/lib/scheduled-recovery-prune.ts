import { runBoundedPrune } from "./bounded-prune";

export async function pruneLiveReserveRecoveryCheckpoints(
  db: D1Database,
  cutoffUpdatedAt: number,
  signal?: AbortSignal,
  limits: { batchLimit?: number; runLimit?: number } = {},
): Promise<{ deleted: number; truncated: boolean }> {
  const deleteSql = `DELETE FROM worker_scheduled_checkpoints
    WHERE rowid IN (
      SELECT rowid
      FROM worker_scheduled_checkpoints
      WHERE updated_at < ?
        AND state IN ('completed', 'failed', 'platform_abandoned')
      ORDER BY updated_at ASC
      LIMIT ?
    )`;
  const batchLimit = limits.batchLimit ?? 5_000;
  const runLimit = limits.runLimit ?? 20_000;
  return runBoundedPrune({
    batchLimit,
    runLimit,
    signal,
    deleteBatch: (limit) => db.prepare(deleteSql).bind(cutoffUpdatedAt, limit).run(),
  });
}
