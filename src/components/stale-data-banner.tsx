"use client";

import { DataHealthBanner } from "@/components/data-health-banner";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import type { StaleQuery } from "@/lib/stale-query";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";

export type { StaleQuery } from "@/lib/stale-query";

/**
 * A first fetch or seed awaiting its first live read is not a settled health
 * finding. Errors always join the banner; callers clear awaitingLiveRead on
 * success or pause. Explicit isLoading: false keeps an empty query evaluated.
 */
function isExcludedWhileUnsettled(query: StaleQuery): boolean {
  if (query.error) return false;
  if (query.awaitingLiveRead) return true;
  if (query.hasData ?? query.dataUpdatedAt > 0) return false;
  return query.isLoading ?? query.dataUpdatedAt === 0;
}

export function StaleDataBanner({
  queries,
  onRetry,
}: {
  queries: readonly StaleQuery[];
  onRetry?: () => void;
}) {
  const inputs = queries.filter((q) => !isExcludedWhileUnsettled(q)).map((q) => {
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
