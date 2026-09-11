import type { Mock } from "vitest";

/**
 * One cursor page as the mocked `useInfiniteQuery` hands it to the event hooks.
 * `meta` stays structural so each suite can supply the minimal envelope it asserts on.
 */
export interface CursorPageFixture<TPageData> {
  data: TPageData;
  meta?: unknown;
}

export interface InfiniteQueryResultOverrides {
  hasNextPage?: boolean;
  fetchNextPage?: () => Promise<unknown>;
  isFetchingNextPage?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
}

/**
 * Idle infinite-query result for `pages`. Defaults describe a settled query with no
 * further cursor; traversal tests override `hasNextPage`/`fetchNextPage` explicitly so
 * the exhausted state stays consistent with the terminal page's cursor.
 */
export function makeInfiniteQueryResult<TPageData>(
  pages: CursorPageFixture<TPageData>[],
  overrides: InfiniteQueryResultOverrides = {},
) {
  return {
    data: pages.length === 0
      ? undefined
      : { pages: pages.map((page) => ({ data: page.data, meta: page.meta ?? null })) },
    error: overrides.error ?? null,
    fetchNextPage: overrides.fetchNextPage ?? (async () => undefined),
    hasNextPage: overrides.hasNextPage ?? false,
    isFetchingNextPage: overrides.isFetchingNextPage ?? false,
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
  };
}

export interface InfiniteQueryOptionsLike {
  queryKey: unknown[];
  staleTime: number;
  refetchInterval: number;
  queryFn: (context: { pageParam: string | null; signal?: AbortSignal }) => Promise<unknown>;
  getNextPageParam: (lastPage: { data: { nextCursor?: string | null } }) => string | null | undefined;
}

/** Options object from the most recent mocked `useInfiniteQuery` call. */
export function latestInfiniteQueryOptions(mock: Mock): InfiniteQueryOptionsLike {
  const latest = mock.mock.calls.at(-1);
  if (!latest) throw new Error("useInfiniteQuery was never called");
  return latest[0] as InfiniteQueryOptionsLike;
}
