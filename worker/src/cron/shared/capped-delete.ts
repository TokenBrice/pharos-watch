import { throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";

export interface CappedDeleteResult {
  pruned: number;
  cappedAtLimit: boolean;
}

/**
 * Runs one capped `DELETE` repeatedly until a batch comes back short (nothing
 * left to prune) or the run budget is exhausted.
 *
 * `bindsForLimit` receives the batch limit and returns the full bind list, so
 * every call site keeps its own cutoff/bind order without this helper knowing
 * the statement shape. `batchLimit` (D1's 30-second per-statement budget) and
 * `runLimit` (the per-run row budget) stay call-site arguments because only the
 * caller knows how expensive its table is.
 */
export async function deleteCapped(
  db: D1Database,
  sql: string,
  bindsForLimit: (limit: number) => unknown[],
  batchLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  let pruned = 0;
  while (pruned < runLimit) {
    throwIfAborted(signal);
    const limit = Math.min(batchLimit, runLimit - pruned);
    const result = await runWithOverloadRetry(
      () => db.prepare(sql).bind(...bindsForLimit(limit)).run(),
      3,
      signal,
    );
    const batchPruned = Number(result.meta?.changes ?? 0);
    pruned += batchPruned;
    if (batchPruned < limit) break;
  }
  return {
    pruned,
    cappedAtLimit: pruned >= runLimit,
  };
}
