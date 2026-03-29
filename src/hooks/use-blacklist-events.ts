"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_BLACKLIST } from "@/lib/cron-intervals";
import { useApiQueryWithMeta } from "./use-api-query";
import {
  buildBlacklistEventsPath,
  type FetchBlacklistEventsParams,
} from "@/lib/blacklist-api";
import {
  BlacklistResponseSchema,
  BlacklistSummaryResponseSchema,
  type BlacklistResponse,
  type BlacklistSummaryResponse,
} from "@shared/types";

export function useBlacklistSummary() {
  return useApiQueryWithMeta<BlacklistSummaryResponse>(
    ["blacklist-summary"],
    API_PATHS.blacklistSummary(),
    CRON_BLACKLIST,
    {
      retry: 1,
      schema: BlacklistSummaryResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
    },
  );
}

export function useBlacklistEventsPage(params: FetchBlacklistEventsParams) {
  return useApiQueryWithMeta<BlacklistResponse>(
    ["blacklist-events", params.stablecoin ?? "all", params.chainName ?? "all", params.eventType ?? "all", params.query ?? "", params.limit ?? 50, params.offset ?? 0],
    buildBlacklistEventsPath(params),
    CRON_BLACKLIST,
    {
      retry: 1,
      schema: BlacklistResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklist,
    },
  );
}
