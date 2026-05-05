export interface LiveReserveSyncBudgetConfig {
  adapterTimeoutMs: number;
  runBudgetMs: number;
  d1FinalizeTimeoutMs: number;
}

const DEFAULT_LIVE_RESERVE_SYNC_BUDGETS: LiveReserveSyncBudgetConfig = {
  adapterTimeoutMs: 20_000,
  runBudgetMs: 11 * 60 * 1000,
  d1FinalizeTimeoutMs: 30_000,
};

function positiveFiniteOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function resolveLiveReserveSyncBudgetConfig(
  overrides?: Partial<LiveReserveSyncBudgetConfig>,
): LiveReserveSyncBudgetConfig {
  return {
    adapterTimeoutMs: positiveFiniteOrDefault(
      overrides?.adapterTimeoutMs,
      DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.adapterTimeoutMs,
    ),
    runBudgetMs: positiveFiniteOrDefault(
      overrides?.runBudgetMs,
      DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.runBudgetMs,
    ),
    d1FinalizeTimeoutMs: positiveFiniteOrDefault(
      overrides?.d1FinalizeTimeoutMs,
      DEFAULT_LIVE_RESERVE_SYNC_BUDGETS.d1FinalizeTimeoutMs,
    ),
  };
}
