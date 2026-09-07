import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";

export async function pruneLiveReserveRecoveryCheckpoints(
  db: D1Database,
  cutoffUpdatedAt: number,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM worker_scheduled_checkpoints
          WHERE updated_at < ?
            AND state IN ('completed', 'failed', 'platform_abandoned')`,
      )
      .bind(cutoffUpdatedAt)
      .run(),
    3,
    signal,
  );
  return result.meta?.changes ?? 0;
}
