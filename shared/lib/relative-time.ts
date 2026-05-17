/**
 * Format a millisecond timestamp as a relative time string ("1s ago", "5m ago", "2h ago", "3d ago").
 * Accepts an optional `now` override (ms) for deterministic testing.
 */
export function formatRelativeTimeMs(tsMs: number, opts?: { now?: number }): string {
  const ageSec = Math.max(1, Math.floor(((opts?.now ?? Date.now()) - tsMs) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86_400)}d ago`;
}
