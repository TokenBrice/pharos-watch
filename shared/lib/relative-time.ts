/**
 * Format a millisecond timestamp as a relative time string ("1s ago", "5m ago", "2h ago", "3d ago").
 * Accepts an optional `now` override (ms) for deterministic testing.
 * Pass `withSuffix: false` to get a short token ("1s", "5m", "2h", "3d") for column-style displays.
 */
export function formatRelativeTimeMs(tsMs: number, opts?: { now?: number; withSuffix?: boolean }): string {
  const ageSec = Math.max(1, Math.floor(((opts?.now ?? Date.now()) - tsMs) / 1000));
  const suffix = opts?.withSuffix === false ? "" : " ago";
  if (ageSec < 60) return `${ageSec}s${suffix}`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m${suffix}`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h${suffix}`;
  return `${Math.round(ageSec / 86_400)}d${suffix}`;
}
