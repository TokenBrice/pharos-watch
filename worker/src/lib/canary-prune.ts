import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";

export const WORKER_CANARY_RUN_RETENTION_SEC = 14 * 24 * 3600;

export async function pruneWorkerCanaryRuns(
  db: D1Database,
  cutoffObservedAt: number,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM worker_canary_runs WHERE observed_at < ?")
      .bind(cutoffObservedAt)
      .run(),
    3,
    signal,
  );
  return result.meta?.changes ?? 0;
}
