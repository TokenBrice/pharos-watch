"use client";

import { useApiQueryWithMeta } from "./use-api-query";
import { buildBlacklistEventsPath, type FetchBlacklistEventsParams } from "@/lib/blacklist-api";
import type { BlacklistResponse, BlacklistSummaryResponse } from "@shared/types";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";

export function useBlacklistSummary(options?: { enabled?: boolean }) {
  const descriptor = FRONTEND_API_QUERY_REGISTRY.blacklistSummary;
  return useApiQueryWithMeta<BlacklistSummaryResponse>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    {
      enabled: options?.enabled,
      retry: 1,
      schema: descriptor.schema,
      metaMaxAgeSec: descriptor.metaMaxAgeSec,
    },
  );
}

export function useBlacklistEventsPage(params: FetchBlacklistEventsParams) {
  const descriptor = FRONTEND_API_QUERY_REGISTRY.blacklistEvents({
    queryKey: [
      "blacklist-events",
      params.stablecoin ?? "all",
      params.chainName ?? "all",
      params.eventType ?? "all",
      params.query ?? "",
      params.sortBy ?? "date",
      params.sortDirection ?? "desc",
      params.limit ?? 50,
      params.offset ?? 0,
    ],
    path: buildBlacklistEventsPath(params),
  });
  return useApiQueryWithMeta<BlacklistResponse>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    {
      retry: 1,
      schema: descriptor.schema,
      metaMaxAgeSec: descriptor.metaMaxAgeSec,
    },
  );
}
