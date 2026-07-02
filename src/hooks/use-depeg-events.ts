"use client";

import { useMemo } from "react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { DepegEventsResponse } from "@shared/types";
import { DepegEventsResponseSchema } from "@shared/types/market";
import { apiFetchWithMeta } from "@/lib/api";
import { CRON_15MIN } from "@/lib/cron-intervals";
import { getPollingWindow } from "./use-api-query";
import { useAutoLoadInfinitePages } from "@/hooks/use-auto-load-infinite-pages";

const DEPEG_EVENTS_PAGE_SIZE = 100;

interface UseInfiniteDepegEventsOptions {
  stablecoinId?: string;
  activeOnly?: boolean;
  includePending?: boolean;
  enabled?: boolean;
  autoLoadAll?: boolean;
}

function buildDepegEventsPath({
  stablecoinId,
  limit,
  cursor,
  activeOnly,
  includePending,
}: {
  stablecoinId?: string;
  limit: number;
  cursor?: string | null;
  activeOnly?: boolean;
  includePending?: boolean;
}) {
  return API_PATHS.depegEvents({
    stablecoinId,
    limit,
    cursor: cursor ?? undefined,
    active: activeOnly || undefined,
    includeTotal: false,
    includePending: includePending || undefined,
  });
}

export function depegEventsInfiniteQueryOptions(
  stablecoinId?: string,
  options: { activeOnly?: boolean; includePending?: boolean } = {},
) {
  // Cursor pagination and active/pending variants intentionally stay outside
  // the static query registry; the path builder still comes from API_PATHS.
  const { staleTime, refetchInterval } = getPollingWindow(CRON_15MIN);
  return infiniteQueryOptions({
    queryKey: [
      "depeg-events",
      "infinite",
      stablecoinId ?? null,
      { activeOnly: options.activeOnly === true, includePending: options.includePending === true },
    ] as const,
    initialPageParam: null as string | null,
    staleTime,
    refetchInterval,
    retry: 2,
    queryFn: async ({ pageParam, signal }) =>
      apiFetchWithMeta<DepegEventsResponse>(
        buildDepegEventsPath({
          stablecoinId,
          limit: DEPEG_EVENTS_PAGE_SIZE,
          cursor: pageParam,
          activeOnly: options.activeOnly,
          includePending: options.includePending,
        }),
        DepegEventsResponseSchema,
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.data.nextCursor ?? undefined,
  });
}

export function useInfiniteDepegEvents({
  stablecoinId,
  activeOnly = false,
  includePending = false,
  enabled = true,
  autoLoadAll = false,
}: UseInfiniteDepegEventsOptions = {}) {
  const query = useInfiniteQuery({
    ...depegEventsInfiniteQueryOptions(stablecoinId, { activeOnly, includePending }),
    enabled,
  });
  const { error, fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  useAutoLoadInfinitePages({
    enabled,
    autoLoadAll,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  });

  // Keep page-derived values stable across unrelated rerenders. The events
  // page already carries the cursor-specific fetch behavior, while the depeg
  // response schema/total semantics differ enough that a shared query-options
  // helper would add more abstraction than it removes.
  const pages = query.data?.pages;
  const events = useMemo(
    () => pages?.flatMap((page) => page.data.events) ?? [],
    [pages],
  );
  const total = useMemo(() => pages?.[0]?.data.total ?? 0, [pages]);
  const totalExact = useMemo(() => pages?.[0]?.data.totalExact ?? true, [pages]);
  const nextCursor = useMemo(() => pages?.[pages.length - 1]?.data.nextCursor ?? null, [pages]);
  const pending = useMemo(() => pages?.[0]?.data.pending ?? [], [pages]);
  const meta = useMemo(() => pages?.[0]?.meta ?? null, [pages]);
  const data = useMemo(
    () => ({ events, total, totalExact, nextCursor, pending }),
    [events, nextCursor, pending, total, totalExact],
  );

  return {
    ...query,
    data,
    loadedCount: events.length,
    isFullyLoaded: nextCursor == null && (!totalExact || total === 0 || events.length >= total),
    meta,
  };
}

export function useActiveDepegEvents(options: Omit<UseInfiniteDepegEventsOptions, "activeOnly"> = {}) {
  return useInfiniteDepegEvents({
    ...options,
    activeOnly: true,
  });
}
