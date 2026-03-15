"use client";

import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { DepegEventsResponseSchema, type DepegEventsResponse } from "@shared/types";
import { apiFetchWithMeta } from "@/lib/api";
import { CRON_15MIN } from "@/lib/cron-intervals";

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

export function useInfiniteDepegEvents({
  stablecoinId,
  enabled = true,
  autoLoadAll = false,
}: UseInfiniteDepegEventsOptions = {}) {
  const query = useInfiniteQuery({
    queryKey: ["depeg-events", "infinite", stablecoinId ?? null],
    initialPageParam: 0,
    staleTime: CRON_15MIN,
    refetchInterval: 2 * CRON_15MIN,
    retry: 2,
    enabled,
    queryFn: async ({ pageParam }) => apiFetchWithMeta<DepegEventsResponse>(
      buildDepegEventsPath({
        stablecoinId,
        limit: DEPEG_EVENTS_PAGE_SIZE,
        offset: pageParam,
      }),
      DepegEventsResponseSchema,
    ),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.data.events.length, 0);
      return loaded < lastPage.data.total ? loaded : undefined;
    },
  });
  const { error, fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  useEffect(() => {
    if (!autoLoadAll || !enabled || !hasNextPage || isFetchingNextPage || error) {
      return;
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
