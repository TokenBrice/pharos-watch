"use client";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";

interface QueryFreshnessNoticesProps {
  error: unknown | null | undefined;
  hasData?: boolean;
  onRetry?: () => void;
  queries: readonly StaleQuery[];
  showFreshnessBanner?: boolean;
  /** Supplemental lanes: a failure reads as a caution, below the page's lead. */
  secondary?: boolean;
}

export function QueryFreshnessNotices({
  error,
  hasData,
  onRetry,
  queries,
  showFreshnessBanner = true,
  secondary,
}: QueryFreshnessNoticesProps) {
  const resolvedHasData = hasData ?? queries.some((query) => query.hasData ?? query.dataUpdatedAt > 0);
  const hasBlockingError = Boolean(error) && !resolvedHasData;
  // Suppress queries already surfaced by the blocking QueryErrorNotice so a
  // failed load renders one unified failure card instead of stacked banners.
  const freshnessQueries = hasBlockingError
    ? queries.filter((query) => {
        const queryHasData = query.hasData ?? query.dataUpdatedAt > 0;
        return query.error !== error && (!query.error || queryHasData);
      })
    : queries;

  return (
    <>
      <QueryErrorNotice error={error} hasData={resolvedHasData} onRetry={onRetry} />
      {/* With retained data the error notice is silent, so a stale banner carries the retry. */}
      {showFreshnessBanner && freshnessQueries.length > 0 ? (
        <StaleDataBanner
          queries={freshnessQueries}
          onRetry={resolvedHasData ? onRetry : undefined}
          secondary={secondary}
        />
      ) : null}
    </>
  );
}
