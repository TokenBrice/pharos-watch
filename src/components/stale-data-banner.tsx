"use client";

/**
 * Warns users when data from any critical query exceeds 2x its staleTime.
 * Usage: <StaleDataBanner queries={[{ label: "Prices", dataUpdatedAt, staleTime: CRON_15MIN }]} />
 */
export interface StaleQuery {
  label: string;
  /** Timestamp in ms (from TanStack Query's dataUpdatedAt), 0 if never fetched */
  dataUpdatedAt: number;
  /** staleTime in ms (the cron interval) */
  staleTime: number;
}

export function StaleDataBanner({ queries }: { queries: StaleQuery[] }) {
  const now = Date.now();
  const staleQueries = queries.filter(
    (q) => q.dataUpdatedAt > 0 && now - q.dataUpdatedAt > 2 * q.staleTime,
  );

  if (staleQueries.length === 0) return null;

  const labels = staleQueries.map((q) => q.label).join(", ");

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400">
      Data may be stale ({labels}). Last update was over{" "}
      {formatAge(staleQueries.reduce((m, q) => Math.max(m, now - q.dataUpdatedAt), -Infinity))} ago.
    </div>
  );
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
