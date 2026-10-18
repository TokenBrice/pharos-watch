"use client";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";

interface QueryFreshnessNoticesProps {
  error: unknown | null | undefined;
  hasData?: boolean;
  onRetry?: () => void;
  queries: readonly StaleQuery[];
  showFreshnessBanner?: boolean;
  persistent?: boolean;
}

export function QueryFreshnessNotices({
  error,
  hasData,
  onRetry,
  queries,
  showFreshnessBanner = true,
  persistent = false,
}: QueryFreshnessNoticesProps) {
  const resolvedHasData = hasData ?? queries.some((query) => query.hasData ?? query.dataUpdatedAt > 0);

  return (
    <>
      {!persistent ? <QueryErrorNotice error={error} hasData={resolvedHasData} onRetry={onRetry} /> : null}
      {showFreshnessBanner ? <StaleDataBanner queries={queries} persistent={persistent} onRetry={persistent ? onRetry : undefined} /> : null}
    </>
  );
}
