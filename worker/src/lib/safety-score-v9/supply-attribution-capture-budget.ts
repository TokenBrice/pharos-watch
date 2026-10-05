import { SUPPLY_ATTRIBUTION_CAPTURE_BUDGET, SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { throwIfAborted } from "../abort";
import type { V9ExecutionWindow } from "../v9-slot-window";

export type BudgetedSupplyAttributionResult<T> =
  | { status: "completed"; value: T }
  | { status: "rejected"; reason: "asset-timeout" | "capture-window-exhausted" | "observer-failed" };

/** Await cancellation settlement before opening the next asset's connections. */
export async function runBudgetedSupplyAttributionAssets<TAsset, TResult>(
  assets: readonly TAsset[],
  observe: (asset: TAsset, signal: AbortSignal) => Promise<TResult>,
  options: { signal?: AbortSignal; executionWindow?: V9ExecutionWindow } = {},
): Promise<BudgetedSupplyAttributionResult<TResult>[]> {
  if (assets.length > SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS) {
    throw new Error("Supply attribution capture exceeds the bounded cohort");
  }
  throwIfAborted(options.signal);
  const budget = SUPPLY_ATTRIBUTION_CAPTURE_BUDGET;
  const deadlineMs = Math.min(
    Date.now() + budget.wallTimeoutMs,
    options.executionWindow ? options.executionWindow.deadlineMs - budget.publicationReserveMs : Infinity,
  );
  const results = new Array<BudgetedSupplyAttributionResult<TResult>>(assets.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < assets.length) {
      throwIfAborted(options.signal);
      const index = cursor++;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        results[index] = { status: "rejected", reason: "capture-window-exhausted" };
        continue;
      }
      const timeout = createTimeoutSignal({
        timeoutMs: Math.min(budget.assetTimeoutMs, remainingMs),
        timeoutReason: "Supply attribution asset deadline exceeded",
        parentSignal: options.signal,
      });
      try {
        const value = await observe(assets[index], timeout.signal);
        throwIfAborted(options.signal);
        results[index] = timeout.isTimedOut()
          ? { status: "rejected", reason: "asset-timeout" }
          : { status: "completed", value };
      } catch {
        throwIfAborted(options.signal);
        results[index] = { status: "rejected", reason: timeout.isTimedOut() ? "asset-timeout" : "observer-failed" };
      } finally {
        timeout.dispose();
      }
    }
  }
  // Each observer uses at most three connections. Two assets consume the
  // isolated trigger's six-connection budget, never three concurrent assets.
  await Promise.all(Array.from({ length: Math.min(assets.length, budget.assetConcurrency) }, worker));
  return results;
}
