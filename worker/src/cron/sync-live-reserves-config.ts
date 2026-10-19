export interface LiveReserveSyncBudgetConfig {
  adapterTimeoutMs: number;
  runBudgetMs: number;
  d1FinalizeTimeoutMs: number;
  finalizationMarginMs: number;
  minimumAttemptBudgetMs: number;
  maxCoinsPerSlice: number;
}

// Wall and CPU are independent: the four-hour producer has 300s CPU, while
// one-minute continuation polls have 30s. The measured 24.2s/330-coin head
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
export const LIVE_RESERVE_CONTINUATION_BUDGETS = {
  runBudgetMs: CONTINUATION_RUN_BUDGET_MS,
  // More wall time is not more CPU capacity: retain the reviewed 125-coin cap.
  maxCoinsPerSlice: 125,
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

  return {
    adapterTimeoutMs,
    runBudgetMs,
    d1FinalizeTimeoutMs,
    finalizationMarginMs,
    minimumAttemptBudgetMs: adapterTimeoutMs + d1FinalizeTimeoutMs + finalizationMarginMs,
    maxCoinsPerSlice,
  };
}
