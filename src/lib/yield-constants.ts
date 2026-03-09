export const WARNING_SIGNAL_LABELS: Record<string, string> = {
  "yield-spike": "Yield spike",
  "yield-divergence": "Yield divergence",
  "negative-trend": "Negative trend",
  "reward-heavy": "Reward heavy",
  "tvl-outflow": "TVL outflow",
  "data-stale": "Data stale",
};

export function formatYieldWarningSignal(signal: string) {
  return WARNING_SIGNAL_LABELS[signal] ?? signal.replace(/-/g, " ");
}
