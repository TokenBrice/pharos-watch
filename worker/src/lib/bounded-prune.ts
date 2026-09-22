import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";

interface BoundedPruneOptions {
  batchLimit: number;
  runLimit: number;
  signal?: AbortSignal;
  deleteBatch: (limit: number) => Promise<D1Result<unknown>>;
}

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
    const batchDeleted = result.meta?.changes ?? 0;
    deleted += batchDeleted;
    if (batchDeleted < limit) break;
  }
  return { deleted, truncated: deleted >= runLimit };
}
