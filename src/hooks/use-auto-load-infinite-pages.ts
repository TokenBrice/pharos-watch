"use client";

import { useEffect, useRef } from "react";

interface UseAutoLoadInfinitePagesOptions {
  enabled: boolean;
  autoLoadAll: boolean;
  error: unknown;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage?: boolean;
  isFetchingNextPage: boolean;
  maxRetries?: number;
}

export function useAutoLoadInfinitePages({
  enabled,
  autoLoadAll,
  error,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
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
    if (error) {
      retryCountRef.current += 1;
      if (retryCountRef.current > maxRetries) return;
    } else {
      retryCountRef.current = 0;
    }
    void fetchNextPage();
  }, [autoLoadAll, enabled, error, fetchNextPage, hasNextPage, isFetchingNextPage, maxRetries]);
}
