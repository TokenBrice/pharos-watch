"use client";

import { useEffect, useRef } from "react";

interface UseAutoLoadInfinitePagesOptions {
  enabled: boolean;
  autoLoadAll: boolean;
  error: unknown;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage?: boolean;
  isFetchingNextPage: boolean;
  /** Current loaded page count, used with `maxAutoPages` to cap auto-loading. */
  pageCount?: number;
  /** When set, stop auto-loading once `pageCount` reaches this number. */
  maxAutoPages?: number;
  maxRetries?: number;
}

export function useAutoLoadInfinitePages({
  enabled,
  autoLoadAll,
  error,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  pageCount,
  maxAutoPages,
  maxRetries = 3,
}: UseAutoLoadInfinitePagesOptions): void {
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!autoLoadAll) {
      retryCountRef.current = 0;
    }
  }, [autoLoadAll]);

  useEffect(() => {
    if (!autoLoadAll || !enabled || hasNextPage !== true || isFetchingNextPage) {
      return;
    }
    if (maxAutoPages != null && pageCount != null && pageCount >= maxAutoPages) {
      return;
    }
    if (error) {
      retryCountRef.current += 1;
      if (retryCountRef.current > maxRetries) return;
    } else {
      retryCountRef.current = 0;
    }
    void fetchNextPage();
  }, [autoLoadAll, enabled, error, fetchNextPage, hasNextPage, isFetchingNextPage, pageCount, maxAutoPages, maxRetries]);
}
