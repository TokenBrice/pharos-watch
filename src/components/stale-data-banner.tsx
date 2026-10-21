"use client";

import { DataHealthBanner } from "@/components/data-health-banner";
import { deriveDataHealth, type DataHealthCatchUp } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import type { ApiMeta } from "@/lib/api";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";

/**
 * Compatibility wrapper around DataHealthBanner.
 * Prefer using `preset` to keep label/stale-time semantics centralized.
 */
export interface StaleQuery {
  preset?: keyof typeof DATA_HEALTH_PRESETS;
  label?: string;
  /** Timestamp in ms (from TanStack Query's dataUpdatedAt), 0 if never fetched */
  dataUpdatedAt: number;
  /** staleTime in ms (the cron interval) */
  staleTime?: number;
  hasData?: boolean;
  error?: unknown | null;
  meta?: ApiMeta | null;
  /**
   * First fetch in flight (TanStack `isLoading`). When omitted, a query with
   * no data, no error and `dataUpdatedAt === 0` has never settled, so it is
   * treated as in flight.
   */
  isLoading?: boolean;
  /** Producer catch-up detail, so an aged coverage clock with current totals is not read as a stall. */
  catchUp?: DataHealthCatchUp | null;
}

/**
 * A first fetch still in flight is not a health finding: the section it feeds
 * shows its own loading state, and "has not populated yet" would read as a
 * failure. Only once the read settles (data, error, or an empty successful
 * read) does the entry join the banner, so a failed or genuinely unpopulated
 * source is still named. Callers that pass `isLoading: false` keep an
 * unsettled empty query in the banner.
 */
function isFirstFetchInFlight(query: StaleQuery): boolean {
  if (query.error || (query.hasData ?? query.dataUpdatedAt > 0)) return false;
  return query.isLoading ?? query.dataUpdatedAt === 0;
}

export function StaleDataBanner({
  queries,
  onRetry,
}: {
  queries: readonly StaleQuery[];
  onRetry?: () => void;
}) {
  const inputs = queries.filter((q) => !isFirstFetchInFlight(q)).map((q) => {
    const preset = q.preset ? DATA_HEALTH_PRESETS[q.preset] : null;
    return {
      query: q,
      label: q.label ?? preset?.label ?? "Data",
      dataUpdatedAt: q.dataUpdatedAt,
      staleTime: q.staleTime ?? preset?.staleTime ?? 15 * 60_000,
      hasData: q.hasData ?? q.dataUpdatedAt > 0,
      error: q.error,
      meta: q.meta ?? null,
      catchUp: q.catchUp,
    };
  });
  const nowMs = useFreshnessBoundary(inputs);
  const health = inputs.map(({ query: q, ...input }) => deriveDataHealth(input, nowMs ?? q.dataUpdatedAt));

  return <DataHealthBanner entries={health} onRetry={queries.some((query) => query.error) ? onRetry : undefined} />;
}
