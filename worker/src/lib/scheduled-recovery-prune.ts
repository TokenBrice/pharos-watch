import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";

export async function pruneLiveReserveRecoveryCheckpoints(
  db: D1Database,
  cutoffUpdatedAt: number,
  signal?: AbortSignal,
  limits: { batchLimit?: number; runLimit?: number } = {},
): Promise<{ deleted: number; truncated: boolean }> {
  const batchLimit = limits.batchLimit ?? 5_000;
  const runLimit = limits.runLimit ?? 20_000;
  let deleted = 0;
  while (deleted < runLimit) {
    throwIfAborted(signal);
    const limit = Math.min(batchLimit, runLimit - deleted);
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `DELETE FROM worker_scheduled_checkpoints
           WHERE rowid IN (
             SELECT rowid
             FROM worker_scheduled_checkpoints
             WHERE updated_at < ?
               AND state IN ('completed', 'failed', 'platform_abandoned')
             ORDER BY updated_at ASC
             LIMIT ?
           )`,
        )
        .bind(cutoffUpdatedAt, limit)
        .run(),
      3,
      signal,
    );
    const batchDeleted = result.meta?.changes ?? 0;
    deleted += batchDeleted;
    if (batchDeleted < limit) break;
  }
  return { deleted, truncated: deleted >= runLimit };
}
