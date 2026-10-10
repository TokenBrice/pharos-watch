import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";
import type { MinimalD1RunResult } from "./minimal-d1";

interface BoundedPruneOptions {
  batchLimit: number;
  runLimit: number;
  signal?: AbortSignal;
  deleteBatch: (limit: number) => Promise<MinimalD1RunResult>;
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
    const batchDeleted = Number(result.meta?.changes ?? 0);
    deleted += batchDeleted;
    if (batchDeleted < limit) break;
  }
  return { deleted, truncated: deleted >= runLimit };
}
