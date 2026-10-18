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
export const RETENTION_SMALL_DELETE_BATCH_LIMIT = 5_000;
export const RETENTION_SMALL_DELETE_RUN_LIMIT = 20_000;

export interface BoundedPruneResult {
  deleted: number;
  truncated: boolean;
}

/**
 * Drain independent statements in rounds. Each statement retains its own
 * remaining budget and stops on its first short batch. The caller owns the
 * transaction boundary: dependent statements must be supplied in later groups.
 */
export async function runBoundedPruneGroup(
  entries: readonly { batchLimit: number; runLimit: number }[],
  deleteBatches: (batches: readonly { index: number; limit: number }[]) => Promise<readonly MinimalD1RunResult[]>,
  signal?: AbortSignal,
): Promise<BoundedPruneResult[]> {
  const results = entries.map(({ runLimit }) => ({ deleted: 0, truncated: runLimit <= 0 }));
  let active = entries.map((_, index) => index).filter((index) => entries[index].runLimit > 0);
  while (active.length > 0) {
    throwIfAborted(signal);
    const batches = active.map((index) => ({
      index,
      limit: Math.min(entries[index].batchLimit, entries[index].runLimit - results[index].deleted),
    }));
    const round = await runWithOverloadRetry(() => deleteBatches(batches), 3, signal);
    if (round.length !== batches.length) throw new Error("Retention batch result count mismatch");
    const next: number[] = [];
    for (let offset = 0; offset < batches.length; offset += 1) {
      const { index, limit } = batches[offset];
      const changed = Number(round[offset].meta?.changes ?? 0);
      results[index].deleted += changed;
      results[index].truncated = results[index].deleted >= entries[index].runLimit;
      if (changed >= limit && !results[index].truncated) next.push(index);
    }
    active = next;
  }
  throwIfAborted(signal);
  return results;
}

export async function runBoundedPrune({
  batchLimit,
  runLimit,
  signal,
  deleteBatch,
}: BoundedPruneOptions): Promise<{ deleted: number; truncated: boolean }> {
  const [result] = await runBoundedPruneGroup(
    [{ batchLimit, runLimit }],
    async ([batch]) => [await deleteBatch(batch.limit)],
    signal,
  );
  return result;
}
