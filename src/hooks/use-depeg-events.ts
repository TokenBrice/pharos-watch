"use client";

import { useEffect, useRef } from "react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { DepegEventsResponseSchema, type DepegEventsResponse } from "@shared/types";
import { apiFetchWithMeta } from "@/lib/api";
import { CRON_15MIN } from "@/lib/cron-intervals";
import { getPollingWindow } from "./use-api-query";

const DEPEG_EVENTS_PAGE_SIZE = 100;

interface UseInfiniteDepegEventsOptions {
  stablecoinId?: string;
  enabled?: boolean;
  autoLoadAll?: boolean;
}

function buildDepegEventsPath({
  stablecoinId,
  limit,
  offset,
}: {
  stablecoinId?: string;
  limit: number;
  offset: number;
}) {
  return API_PATHS.depegEvents({ stablecoinId, limit, offset });
}

export function depegEventsInfiniteQueryOptions(stablecoinId?: string) {
  const { staleTime, refetchInterval } = getPollingWindow(CRON_15MIN);
  return infiniteQueryOptions({
    queryKey: ["depeg-events", "infinite", stablecoinId ?? null] as const,
    initialPageParam: 0,
    staleTime,
    refetchInterval,
    retry: 2,
    queryFn: async ({ pageParam, signal }) => apiFetchWithMeta<DepegEventsResponse>(
      buildDepegEventsPath({
        stablecoinId,
        limit: DEPEG_EVENTS_PAGE_SIZE,
        offset: pageParam,
      }),
      DepegEventsResponseSchema,
      { signal },
    ),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.data.events.length, 0);
      return loaded < lastPage.data.total ? loaded : undefined;
    },
  });
}

export function useInfiniteDepegEvents({
  stablecoinId,
  enabled = true,
  autoLoadAll = false,
}: UseInfiniteDepegEventsOptions = {}) {
  const query = useInfiniteQuery({
    ...depegEventsInfiniteQueryOptions(stablecoinId),
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
  }, [
    autoLoadAll,
    enabled,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  ]);

  const events = query.data?.pages.flatMap((page) => page.data.events) ?? [];
  const total = query.data?.pages[0]?.data.total ?? 0;
  const meta = query.data?.pages[0]?.meta ?? null;

  return {
    ...query,
    data: { events, total },
    loadedCount: events.length,
    isFullyLoaded: total === 0 || events.length >= total,
    meta,
  };
}
