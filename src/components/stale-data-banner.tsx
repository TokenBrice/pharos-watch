"use client";

import { DataHealthBanner } from "@/components/data-health-banner";
import { deriveDataHealth, type DataHealthCatchUp, type DataHealthInfo } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import type { ApiMeta } from "@/lib/api";
import { useHydrated } from "@/hooks/use-hydrated";

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
  /** A saved query's first live read, distinct from subsequent polling. */
  isFetching?: boolean;
  isFetchedAfterMount?: boolean;
  /** True only while this cache generation is an unsettled build snapshot. */
  isSnapshot?: boolean;
  /** Producer catch-up detail, so an aged coverage clock with current totals is not read as a stall. */
  catchUp?: DataHealthCatchUp | null;
  /** Drop this entry when its only finding is a producer catch-up (compact surfaces defer that notice to the owning page). */
  hideCatchUp?: boolean;
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
  persistent = false,
  onRetry,
}: {
  queries: readonly StaleQuery[];
  persistent?: boolean;
  onRetry?: () => void;
}) {
  const hydrated = useHydrated();
  const refreshingEntries: DataHealthInfo[] = [];
  const health = queries.filter((q) => !isFirstFetchInFlight(q)).flatMap((q) => {
    const preset = q.preset ? DATA_HEALTH_PRESETS[q.preset] : null;
    const label = q.label ?? preset?.label ?? "Data";
    const staleTime = q.staleTime ?? preset?.staleTime ?? 15 * 60_000;
    // Initial markup describes the saved query; browser-clock aging begins after hydration.
    const info = deriveDataHealth({
      label,
      dataUpdatedAt: q.dataUpdatedAt,
      staleTime,
      hasData: q.hasData ?? q.dataUpdatedAt > 0,
      error: q.error,
      meta: q.meta ?? null,
      catchUp: q.catchUp,
    }, hydrated ? undefined : q.dataUpdatedAt);
    if (persistent && q.isSnapshot && q.isFetching && q.isFetchedAfterMount === false
      && !q.error && info.dataUpdatedAt > 0 && (q.hasData ?? q.dataUpdatedAt > 0)
      && info.degradationReason !== "source" && !info.catchUp
      && (!q.meta?.warning || q.meta.warning.startsWith("110 "))
      && Object.values(q.meta?.dependencies ?? {}).every((dependency) => dependency.status === "fresh")) {
      refreshingEntries.push(info);
      return [];
    }
    return q.hideCatchUp && info.degradationReason === "catch-up" ? [] : [info];
  });

  return <DataHealthBanner entries={health} persistent={persistent} refreshingEntries={refreshingEntries} onRetry={queries.some((query) => query.error) ? onRetry : undefined} />;
}
