export interface LiveReserveSyncBudgetConfig {
  adapterTimeoutMs: number;
  runBudgetMs: number;
  d1FinalizeTimeoutMs: number;
  finalizationMarginMs: number;
  minimumAttemptBudgetMs: number;
}

// The leased outer wrapper gives sync-live-reserves a 12-minute (720s)
// wall-clock budget whose clock starts before this loop's pre-flight D1 reads
// (cursor + sync-state map). The internal run budget is deliberately held a
// full ~2 minutes under that cap: the worst case is an admit-at-edge attempt
// (adapter 20s + finalize 30s + margin 5s) landing the internal loop at ~600s,
// after which the untimed pre-loop load plus the deferred-tail / finalize /
// cron-logging tail must still clear the outer cap. At 11min that tail headroom
// was ~20-25s and occasional runs were killed at the 720s lease (watchdog
// cap-hits); 10min restores ~85-110s of headroom so deferral stays graceful
// (deferred coins resume next run via the persisted cursor).
const DEFAULT_LIVE_RESERVE_SYNC_BUDGETS = {
  adapterTimeoutMs: 20_000,
  runBudgetMs: 10 * 60 * 1000,
  d1FinalizeTimeoutMs: 30_000,
  finalizationMarginMs: 5_000,
};

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

  return {
    adapterTimeoutMs,
    runBudgetMs,
    d1FinalizeTimeoutMs,
    finalizationMarginMs,
    minimumAttemptBudgetMs: adapterTimeoutMs + d1FinalizeTimeoutMs + finalizationMarginMs,
  };
}
