"use client";

import { CRON_BLACKLIST } from "@/lib/cron-intervals";
import { usePollingQuery } from "./use-api-query";
import {
  fetchBlacklistEvents,
  fetchBlacklistSummary,
  type FetchBlacklistEventsParams,
} from "@/lib/blacklist-api";

export function useBlacklistSummary() {
  return usePollingQuery(["blacklist-summary"], fetchBlacklistSummary, CRON_BLACKLIST, { retry: 1 });
}

export function useBlacklistEventsPage(params: FetchBlacklistEventsParams) {
  return usePollingQuery(
    ["blacklist-events", params.stablecoin ?? "all", params.chainName ?? "all", params.eventType ?? "all", params.query ?? "", params.limit ?? 50, params.offset ?? 0],
    () => fetchBlacklistEvents(params),
    CRON_BLACKLIST,
    { retry: 1 },
  );
}
