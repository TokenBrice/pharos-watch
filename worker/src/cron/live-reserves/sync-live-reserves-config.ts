export interface LiveReserveSyncBudgetConfig {
  adapterTimeoutMs: number;
  runBudgetMs: number;
  /**
   * Wall time inside `runBudgetMs` that may admit a new coin. The four-hourly
   * producer stops here so cohort growth defers to the continuation lane
   * instead of truncating at the event deadline; continuation slices keep
   * their whole reviewed run budget.
   */
  workBudgetMs: number;
  d1FinalizeTimeoutMs: number;
  finalizationMarginMs: number;
  minimumAttemptBudgetMs: number;
  maxCoinsPerSlice: number;
}

// Wall and CPU are independent: the four-hour producer has 300s CPU, while
// five-minute continuation polls have 30s. The measured 24.2s/330-coin head
// gives ~74ms/coin; reserve 150ms/coin (2x) and 10s for setup/finalization.
// The measured sustainable wall cost is 485s/330 = 1.47s/coin. Admission
// additionally tracks this invocation's observed cost; neither is a CPU timer.
export const LIVE_RESERVE_SLICE_COST = { wallMsPerCoin: 1_470, cpuMsPerCoin: 150, cpuMarginMs: 10_000 } as const;
const CONTINUATION_RUN_BUDGET_MS = 5 * 60_000;
const DEFAULT_LIVE_RESERVE_SYNC_BUDGETS = {
  adapterTimeoutMs: 20_000,
  runBudgetMs: 9 * 60 * 1000,
  d1FinalizeTimeoutMs: 30_000,
  finalizationMarginMs: 5_000,
};
// The four-hourly producer admits new coins only inside 60% of its run budget
// (324s of 540s). The finalization tail is charged to that same 60%, so the
// remaining 40% (216s, ~147 coins at the observed cost) stays free for cohort
// growth; this slice yields instead of competing with the event deadline.
export const LIVE_RESERVE_PRODUCER_WORK_BUDGET_RATIO = 0.6;
const PRODUCER_WORK_BUDGET_MS = Math.floor(
  DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.runBudgetMs * LIVE_RESERVE_PRODUCER_WORK_BUDGET_RATIO,
) - DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.d1FinalizeTimeoutMs - DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.finalizationMarginMs;
export const LIVE_RESERVE_PRODUCER_BUDGETS = {
  workBudgetMs: PRODUCER_WORK_BUDGET_MS,
} as const;
export const LIVE_RESERVE_CONTINUATION_BUDGETS = {
  runBudgetMs: CONTINUATION_RUN_BUDGET_MS,
  // More wall time is not more CPU capacity: retain the reviewed 125-coin cap.
  maxCoinsPerSlice: 125,
  // A continuation slice owns its whole reviewed wall budget; the 125-coin CPU
  // cap, not an earlier yield, bounds it.
  workBudgetMs: CONTINUATION_RUN_BUDGET_MS,
} as const;

function positiveFiniteOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function resolveLiveReserveSyncBudgetConfig(
  overrides?: Partial<LiveReserveSyncBudgetConfig>,
): LiveReserveSyncBudgetConfig {
  const adapterTimeoutMs = positiveFiniteOrDefault(
    overrides?.adapterTimeoutMs,
    DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.adapterTimeoutMs,
  );
  const runBudgetMs = positiveFiniteOrDefault(
    overrides?.runBudgetMs,
    DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.runBudgetMs,
  );
  const d1FinalizeTimeoutMs = positiveFiniteOrDefault(
    overrides?.d1FinalizeTimeoutMs,
    DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.d1FinalizeTimeoutMs,
  );
  const finalizationMarginMs = positiveFiniteOrDefault(
    overrides?.finalizationMarginMs,
    DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.finalizationMarginMs,
  );
  const cpuCapacity = Math.floor((300_000 - LIVE_RESERVE_SLICE_COST.cpuMarginMs) / LIVE_RESERVE_SLICE_COST.cpuMsPerCoin);
  const maxCoinsPerSlice = Math.min(cpuCapacity, positiveFiniteOrDefault(overrides?.maxCoinsPerSlice, cpuCapacity));
  // The default budget set is the full run budget: only callers that opt into
  // an earlier yield (the four-hourly producer) lose admission headroom, and a
  // caller that shrinks the run budget never admits work beyond it.
  const workBudgetMs = Math.min(runBudgetMs, positiveFiniteOrDefault(overrides?.workBudgetMs, runBudgetMs));

  return {
    adapterTimeoutMs,
    runBudgetMs,
    workBudgetMs,
    d1FinalizeTimeoutMs,
    finalizationMarginMs,
    minimumAttemptBudgetMs: adapterTimeoutMs + d1FinalizeTimeoutMs + finalizationMarginMs,
    maxCoinsPerSlice,
  };
}
