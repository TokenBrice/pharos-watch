"use client";

import { useMemo } from "react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { TAPE_EVENT_SEVERITY_VALUES, type TapeEventSeverity } from "@shared/types/tape-event-constants";
import type { TapeEvent, TapeEventsResponse } from "@shared/types/tape-event";
import { apiFetchWithMeta } from "@/lib/api";
import { CRON_TAPE } from "@/lib/cron-intervals";
import { createLazySchema } from "@shared/lib/schema-like";
import { useApiQueryWithMeta, getPollingWindow } from "./use-api-query";
import { useAutoLoadInfinitePages } from "@/hooks/use-auto-load-infinite-pages";

type TapeEventsResponseBody = Omit<TapeEventsResponse, "_meta">;

const loadTapeEventsResponseBodySchema = createLazySchema<TapeEventsResponseBody>(async () =>
  (await import("@shared/types/tape-event")).TapeEventsResponseSchema.omit({ _meta: true }),
);

const TAPE_EVENTS_PAGE_SIZE = 500;

export interface UseEventsFilter {
  /** Type slugs (exact or `prefix.*` wildcard). Comma-joined when passed via URL. */
  type?: readonly string[];
  /** Single canonical coin id. */
  coin?: string;
  /** Peg currency (e.g. `USD`, `EUR`). */
  pegCurrency?: string;
  /** Chain id from `CHAIN_META`. */
  chain?: string;
  /** Severity floor (inclusive). */
  severityFloor?: TapeEventSeverity;
  /** Epoch ms — inclusive lower bound. */
  since?: number;
  /** Epoch ms — inclusive upper bound. */
  until?: number;
  /** Free-text query matched against title/summary/coin_id. */
  q?: string;
}

function eventsQueryKeyFilters(filter: UseEventsFilter): Record<string, unknown> {
  // Normalise so the query key is stable across equivalent filters.
  const types = filter.type && filter.type.length > 0 ? [...filter.type].sort() : null;
  return {
    type: types,
    coin: filter.coin ?? null,
    pegCurrency: filter.pegCurrency ?? null,
    chain: filter.chain ?? null,
    severityFloor: filter.severityFloor ?? null,
    since: filter.since ?? null,
    until: filter.until ?? null,
    q: filter.q ?? null,
  };
}

interface BuildEventsPathOptions {
  limit: number;
  cursor?: string | null;
  includeTotal?: boolean;
}

function buildEventsParams(filter: UseEventsFilter, options: BuildEventsPathOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.type) {
    for (const slug of filter.type) {
      const trimmed = slug.trim();
      if (trimmed) params.append("type", trimmed);
    }
  }
  if (filter.coin) params.set("coin", filter.coin);
  if (filter.pegCurrency) params.set("pegCurrency", filter.pegCurrency);
  if (filter.chain) params.set("chain", filter.chain);
  if (filter.severityFloor) params.set("severityFloor", filter.severityFloor);
  if (filter.since != null) params.set("since", String(filter.since));
  if (filter.until != null) params.set("until", String(filter.until));
  if (filter.q) params.set("q", filter.q);
  params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.includeTotal) params.set("includeTotal", "true");
  return params;
}

function buildEventsPath(filter: UseEventsFilter, options: BuildEventsPathOptions): string {
  const params = buildEventsParams(filter, options);
  return `${API_PATHS.events()}?${params.toString()}`;
}

function eventsInfiniteQueryOptions(filter: UseEventsFilter = {}) {
  // Infinite event feeds keep a custom descriptor because each page carries a
  // cursor and the first page alone requests the expensive total count.
  const { staleTime, refetchInterval } = getPollingWindow(CRON_TAPE);
  return infiniteQueryOptions({
    queryKey: ["events", "infinite", eventsQueryKeyFilters(filter)] as const,
    initialPageParam: null as string | null,
    staleTime,
    refetchInterval,
    retry: 2,
    // `includeTotal` runs an extra COUNT(*) on D1; only request it on the
    // first page so the badge can show "Showing N of M" without paying the
    // cost on every paginated load.
    queryFn: async ({ pageParam, signal }) => {
      const schema = await loadTapeEventsResponseBodySchema();
      return apiFetchWithMeta<TapeEventsResponseBody>(
        buildEventsPath(filter, {
          limit: TAPE_EVENTS_PAGE_SIZE,
          cursor: pageParam,
          includeTotal: pageParam == null,
        }),
        schema,
        { signal },
      );
    },
    getNextPageParam: (lastPage) => lastPage.data.nextCursor ?? undefined,
  });
}

export interface UseEventsOptions {
  enabled?: boolean;
  /** If true, automatically fetches every page after the first manual click. */
  autoLoadAll?: boolean;
  /** Cap auto-loading at this many pages. Implies `autoLoadAll: true`. */
  maxAutoPages?: number;
}

export function useEvents(filter: UseEventsFilter = {}, options: UseEventsOptions = {}) {
  const { enabled = true, autoLoadAll = false, maxAutoPages } = options;
  const effectiveAutoLoadAll = autoLoadAll || maxAutoPages != null;
  const query = useInfiniteQuery({
    ...eventsInfiniteQueryOptions(filter),
    enabled,
  });
  const { error, fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  useAutoLoadInfinitePages({
    enabled,
    autoLoadAll: effectiveAutoLoadAll,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    pageCount: query.data?.pages.length,
    maxAutoPages,
  });

  // All five derived values are computed from `query.data?.pages`, which is a
  // stable reference across renders within the same TanStack Query cache state.
  // Memoising on `pages` keeps the flattened `events` array (and the returned
  // `data` object) referentially stable, so downstream `useMemo` consumers in
  // `client.tsx` (`visibleEvents`, `openIncidents`, `digestedDays`) don't
  // invalidate on unrelated re-renders.
  const pages = query.data?.pages;

  const events = useMemo<TapeEvent[]>(() => pages?.flatMap((page) => page.data.events) ?? [], [pages]);
  const nextCursor = useMemo(() => pages?.[pages.length - 1]?.data.nextCursor ?? null, [pages]);
  const meta = useMemo(() => pages?.[0]?.meta ?? null, [pages]);
  const total = useMemo(() => pages?.[0]?.data.total ?? null, [pages]);
  const data = useMemo(() => ({ events, nextCursor }), [events, nextCursor]);

  return {
    ...query,
    data,
    pages,
    loadedCount: events.length,
    isFullyLoaded: nextCursor == null,
    meta,
    total,
  };
}

export interface UseLatestEventsOptions {
  /** Max events to request. Default 20. Backend caps at 500. */
  limit?: number;
  /** Restrict to a single coin id. */
  coin?: string;
  /** Restrict to events with type prefix (e.g. `depeg`). */
  classSlug?: string;
  /** Epoch ms — only return events newer than this. */
  since?: number;
  /** Event type slugs (exact or `prefix.*`). */
  type?: readonly string[];
  /** Severity floor (inclusive). */
  severityFloor?: TapeEventSeverity;
  enabled?: boolean;
}

export function useLatestEvents(options: UseLatestEventsOptions = {}) {
  const { limit = 20, coin, classSlug, since, type, severityFloor, enabled = true } = options;
  const typeFilters = classSlug ? [`${classSlug}.*`] : type;
  const path = buildEventsPath({ coin, since, type: typeFilters, severityFloor }, { limit });
  const result = useApiQueryWithMeta<TapeEventsResponseBody>(
    [
      "events",
      "latest",
      {
        limit,
        coin: coin ?? null,
        since: since ?? null,
        type: typeFilters ? [...typeFilters].sort() : null,
        severityFloor: severityFloor ?? null,
      },
    ],
    path,
    CRON_TAPE,
    { enabled, schema: loadTapeEventsResponseBodySchema },
  );
  return result;
}

// Exposed for tests + cross-component reuse.
export const TAPE_FILTER_SEVERITY_VALUES = TAPE_EVENT_SEVERITY_VALUES;
export type { TapeEvent };
