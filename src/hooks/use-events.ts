"use client";

import { useEffect, useRef } from "react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  TAPE_EVENT_SEVERITY_VALUES,
  TapeEventsResponseSchema,
  type TapeEvent,
  type TapeEventSeverity,
} from "@shared/types/tape-event";
import { apiFetchWithMeta } from "@/lib/api";
import { CRON_15MIN } from "@/lib/cron-intervals";
import { useApiQueryWithMeta, getPollingWindow } from "./use-api-query";

// The wire `TapeEventsResponseSchema` includes the `_meta` envelope. Our
// `apiFetchWithMeta` lifts `_meta` off the body before schema parsing, so we
// validate against a body-only projection here and re-attach meta via the
// fetcher. Mirrors the depeg-events pattern.
const TapeEventsResponseBodySchema = TapeEventsResponseSchema.omit({ _meta: true });
type TapeEventsResponseBody = z.infer<typeof TapeEventsResponseBodySchema>;

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

function buildEventsParams(
  filter: UseEventsFilter,
  options: BuildEventsPathOptions,
): URLSearchParams {
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
  const { staleTime, refetchInterval } = getPollingWindow(CRON_15MIN);
  return infiniteQueryOptions({
    queryKey: ["events", "infinite", eventsQueryKeyFilters(filter)] as const,
    initialPageParam: null as string | null,
    staleTime,
    refetchInterval,
    retry: 2,
    // `includeTotal` runs an extra COUNT(*) on D1; only request it on the
    // first page so the badge can show "Showing N of M" without paying the
    // cost on every paginated load.
    queryFn: async ({ pageParam, signal }) =>
      apiFetchWithMeta<TapeEventsResponseBody>(
        buildEventsPath(filter, {
          limit: TAPE_EVENTS_PAGE_SIZE,
          cursor: pageParam,
          includeTotal: pageParam == null,
        }),
        TapeEventsResponseBodySchema,
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.data.nextCursor ?? undefined,
  });
}

export interface UseEventsOptions {
  enabled?: boolean;
  /** If true, automatically fetches every page after the first manual click. */
  autoLoadAll?: boolean;
}

export function useEvents(filter: UseEventsFilter = {}, options: UseEventsOptions = {}) {
  const { enabled = true, autoLoadAll = false } = options;
  const query = useInfiniteQuery({
    ...eventsInfiniteQueryOptions(filter),
    enabled,
  });
  const { error, fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const retryCountRef = useRef(0);
  const MAX_AUTO_LOAD_RETRIES = 3;

  useEffect(() => {
    if (!autoLoadAll) {
      retryCountRef.current = 0;
    }
  }, [autoLoadAll]);

  useEffect(() => {
    if (!autoLoadAll || !enabled || !hasNextPage || isFetchingNextPage) {
      return;
    }
    if (error) {
      retryCountRef.current += 1;
      if (retryCountRef.current > MAX_AUTO_LOAD_RETRIES) return;
    } else {
      retryCountRef.current = 0;
    }
    void fetchNextPage();
  }, [autoLoadAll, enabled, error, fetchNextPage, hasNextPage, isFetchingNextPage]);

  const events: TapeEvent[] = query.data?.pages.flatMap((page) => page.data.events) ?? [];
  const pages = query.data?.pages ?? [];
  const nextCursor = pages[pages.length - 1]?.data.nextCursor ?? null;
  const meta = query.data?.pages[0]?.meta ?? null;
  const total = query.data?.pages[0]?.data.total ?? null;

  return {
    ...query,
    data: { events, nextCursor },
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
  const path = buildEventsPath(
    { coin, since, type: typeFilters, severityFloor },
    { limit },
  );
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
    CRON_15MIN,
    { enabled, schema: TapeEventsResponseBodySchema },
  );
  return result;
}

// Exposed for tests + cross-component reuse.
export const TAPE_FILTER_SEVERITY_VALUES = TAPE_EVENT_SEVERITY_VALUES;
export type { TapeEvent };
