import { SUPPLY_ATTRIBUTION_CAPTURE_BUDGET, SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { throwIfAborted } from "../abort";
import type { V9ExecutionWindow } from "../v9-slot-window";
import type { SupplyAttributionCaptureFailureReason } from "@shared/types/safety-score-v9-supply-attribution";

export type BudgetedSupplyAttributionResult<T> =
  | { status: "completed"; value: T }
  | { status: "rejected"; reason: SupplyAttributionCaptureFailureReason };

/** Await cancellation settlement before opening the next asset's connections. */
export async function runBudgetedSupplyAttributionAssets<TAsset, TResult>(
  assets: readonly TAsset[],
  observe: (asset: TAsset, signal: AbortSignal, assetDeadlineMs: number) => Promise<TResult>,
  options: {
    signal?: AbortSignal;
    executionWindow?: V9ExecutionWindow;
    assetTimeoutMs?: (asset: TAsset) => number;
    /** Rotate execution only; results retain their original asset indexes. */
    startIndex?: number;
  } = {},
): Promise<BudgetedSupplyAttributionResult<TResult>[]> {
  if (assets.length > SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS) {
    throw new Error("Supply attribution capture exceeds the bounded cohort");
  }
  const requestedStartIndex = options.startIndex ?? 0;
  if (!Number.isSafeInteger(requestedStartIndex) || requestedStartIndex < 0) {
    throw new Error("Supply attribution start index must be a nonnegative safe integer");
  }
  const startIndex = assets.length === 0 ? 0 : requestedStartIndex % assets.length;
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
      const index = (startIndex + cursor++) % assets.length;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        results[index] = { status: "rejected", reason: "capture-window-exhausted" };
        continue;
      }
      const assetTimeoutMs = Math.min(options.assetTimeoutMs?.(assets[index]) ?? budget.assetTimeoutMs, remainingMs);
      const assetDeadlineMs = Date.now() + assetTimeoutMs;
      const timeout = createTimeoutSignal({
        timeoutMs: assetTimeoutMs,
        timeoutReason: "Supply attribution asset deadline exceeded",
        parentSignal: options.signal,
      });
      try {
        const value = await observe(assets[index], timeout.signal, assetDeadlineMs);
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
  // Preserve the reviewed serial slot: one observer uses at most three
  // connections, below the slot's five-connection capacity.
  await Promise.all(Array.from({ length: Math.min(assets.length, budget.assetConcurrency) }, worker));
  return results;
}
