"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { DepegEventsResponse } from "@shared/types";
import { DepegEventsResponseSchema } from "@shared/types/market";
import { CRON_15MIN } from "@/lib/cron-intervals";
import { createApiInfinitePollingQueryOptions, useCursorPages } from "./use-api-query";
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
  return createApiInfinitePollingQueryOptions<DepegEventsResponse>(
    [
      "depeg-events",
      "infinite",
      stablecoinId ?? null,
      { activeOnly: options.activeOnly === true, includePending: options.includePending === true },
    ] as const,
    CRON_15MIN,
    DepegEventsResponseSchema,
    (cursor) => buildDepegEventsPath({
      stablecoinId,
      limit: DEPEG_EVENTS_PAGE_SIZE,
      cursor,
      activeOnly: options.activeOnly,
      includePending: options.includePending,
    }),
    (page) => page.nextCursor,
  );
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

  // Keep page-derived values stable across unrelated rerenders while retaining
  // the depeg-specific total, pending, and count semantics below.
  const pages = query.data?.pages;
  const { events, nextCursor, meta } = useCursorPages<
    DepegEventsResponse["events"][number],
    DepegEventsResponse
  >(pages);
  const total = useMemo(() => pages?.[0]?.data.total ?? 0, [pages]);
  const totalExact = useMemo(() => pages?.[0]?.data.totalExact ?? true, [pages]);
  const pending = useMemo(() => pages?.[0]?.data.pending ?? [], [pages]);
  const counts = useMemo(() => pages?.[0]?.data.counts ?? null, [pages]);
  const data = useMemo(
    () => ({ events, total, totalExact, nextCursor, pending, counts }),
    [counts, events, nextCursor, pending, total, totalExact],
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
