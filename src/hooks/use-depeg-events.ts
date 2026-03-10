"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { DepegEventsResponseSchema, type DepegEventsResponse } from "@shared/types";
import { apiFetchWithMeta } from "@/lib/api";
import { useApiQueryWithMeta, CRON_15MIN } from "./use-api-query";

export function useDepegEvents(stablecoinId?: string) {
  const params = stablecoinId ? `?stablecoin=${encodeURIComponent(stablecoinId)}` : "";
  return useApiQueryWithMeta<DepegEventsResponse>(
    ["depeg-events", stablecoinId],
    `/api/depeg-events${params}`,
    CRON_15MIN,
    { schema: DepegEventsResponseSchema },
  );
}

const DEPEG_EVENTS_PAGE_SIZE = 100;

export function useInfiniteDepegEvents() {
  const query = useInfiniteQuery({
    queryKey: ["depeg-events", "infinite"],
    initialPageParam: 0,
    staleTime: CRON_15MIN,
    refetchInterval: 2 * CRON_15MIN,
    retry: 2,
    queryFn: async ({ pageParam }) => apiFetchWithMeta<DepegEventsResponse>(
      `/api/depeg-events?limit=${DEPEG_EVENTS_PAGE_SIZE}&offset=${pageParam}`,
      DepegEventsResponseSchema,
    ),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.data.events.length, 0);
      return loaded < lastPage.data.total ? loaded : undefined;
    },
  });

  const events = query.data?.pages.flatMap((page) => page.data.events) ?? [];
  const total = query.data?.pages[0]?.data.total ?? 0;
  const meta = query.data?.pages[0]?.meta ?? null;

  return {
    ...query,
    data: { events, total },
    meta,
  };
}
