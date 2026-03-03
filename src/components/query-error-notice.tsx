"use client";

import { ApiFetchError } from "@/lib/api";

interface QueryErrorNoticeProps {
  error: unknown | null | undefined;
  hasData?: boolean;
  onRetry?: () => void;
}

export function QueryErrorNotice({ error, hasData = false, onRetry }: QueryErrorNoticeProps) {
  if (!error) return null;

  const isUnavailable = error instanceof ApiFetchError && error.status === 503;
  const isNetworkFetchError =
    error instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);

  const title = hasData
    ? "Live refresh delayed"
    : isUnavailable
      ? "Data not yet available"
      : isNetworkFetchError
        ? "Connection issue"
      : "Failed to load data";

  const message = hasData
    ? "Showing the last successful snapshot while refresh retries."
    : isUnavailable
      ? "This dataset has not been populated yet. Please try again shortly."
      : isNetworkFetchError
        ? "Unable to reach the data API. Please check your connection and try again."
      : error instanceof Error
        ? error.message
        : "Please check your connection and try again.";

  const toneClass = hasData
    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    : isUnavailable
      ? "border-border/60 bg-muted/40 text-muted-foreground"
      : "border-destructive/50 bg-destructive/10 text-destructive";

  return (
    <div className={`rounded-md border p-4 text-sm ${toneClass}`}>
      <p className="font-medium">{title}</p>
      <p className="mt-1">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 text-sm font-medium underline hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none rounded"
        >
          Retry
        </button>
      )}
    </div>
  );
}
