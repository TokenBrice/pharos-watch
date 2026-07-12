"use client";

import { useRegisteredApiQueryWithMeta } from "./api-hooks";
import { buildBlacklistEventsPath, type FetchBlacklistEventsParams } from "@/lib/blacklist-api";
import type { BlacklistResponse, BlacklistSummaryResponse } from "@shared/types";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";

export function useBlacklistSummary(options?: { enabled?: boolean }) {
  return useRegisteredApiQueryWithMeta<BlacklistSummaryResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.blacklistSummary,
    { enabled: options?.enabled, retry: 1 },
  );
}

export function useBlacklistEventsPage(params: FetchBlacklistEventsParams) {
  const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.blacklistEvents({
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
      params.cursor ?? "first",
      params.includeTotal ?? false,
    ],
    path: buildBlacklistEventsPath(params),
  });
  return useRegisteredApiQueryWithMeta<BlacklistResponse>(descriptor, { retry: 1 });
}
