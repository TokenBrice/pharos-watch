"use client";

import { useEffect, useRef } from "react";

/**
 * Ceiling applied when a caller sets `autoLoadAll` without its own bound. Auto-loading walks a
 * cursor the client cannot size in advance, so the traversal is always bounded and the caller
 * reports the remainder as partial rather than fetching and retaining every page.
 */
export const DEFAULT_MAX_AUTO_PAGES = 10;

interface UseAutoLoadInfinitePagesOptions {
  enabled: boolean;
  autoLoadAll: boolean;
  error: unknown;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage?: boolean;
  isFetchingNextPage: boolean;
  /** Current loaded page count; `undefined` until the first page settles. */
  pageCount: number | undefined;
  /** Stop auto-loading once `pageCount` reaches this number. Defaults to `DEFAULT_MAX_AUTO_PAGES`. */
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
  maxAutoPages = DEFAULT_MAX_AUTO_PAGES,
  maxRetries = 3,
}: UseAutoLoadInfinitePagesOptions): void {
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!autoLoadAll) {
      retryCountRef.current = 0;
      return;
    }
    if (!enabled || hasNextPage !== true || isFetchingNextPage) {
      return;
    }
    if ((pageCount ?? 0) >= maxAutoPages) {
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
