import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";
import type { MinimalD1RunResult } from "./minimal-d1";

interface BoundedPruneOptions {
  batchLimit: number;
  runLimit: number;
  signal?: AbortSignal;
  deleteBatch: (limit: number) => Promise<MinimalD1RunResult>;
}

/**
 * Shared ceiling for the daily high-growth retention passes. D1 gives every
 * statement a 30-second budget, so a batch stays at 10,000 rows; the per-run
 * ceiling bounds a multi-week lapse to 100,000 rows so the daily job still
 * finishes inside its slot. Call sites with a different cost profile keep
 * passing their own limits.
 */
export const RETENTION_DELETE_BATCH_LIMIT = 10_000;
export const RETENTION_DELETE_RUN_LIMIT = 100_000;

export async function runBoundedPrune({
  batchLimit,
  runLimit,
  signal,
  deleteBatch,
}: BoundedPruneOptions): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0;
  while (deleted < runLimit) {
    throwIfAborted(signal);
    const limit = Math.min(batchLimit, runLimit - deleted);
    const result = await runWithOverloadRetry(() => deleteBatch(limit), 3, signal);
    const batchDeleted = Number(result.meta?.changes ?? 0);
    deleted += batchDeleted;
    if (batchDeleted < limit) break;
  }
  return { deleted, truncated: deleted >= runLimit };
}
