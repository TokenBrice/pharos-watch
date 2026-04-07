"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

const DEFAULT_HOURS = 24;
const DEFAULT_BUCKET_SEC = 3600;
const DEFAULT_ROUTE_LIMIT = 5;

export function useRequestSourceStats(
): UseQueryResult<ApiRequestAttributionResponse, Error> {
  return useAdminPollingQuery<ApiRequestAttributionResponse>(
    ["request-source-stats", DEFAULT_HOURS, DEFAULT_BUCKET_SEC, DEFAULT_ROUTE_LIMIT],
    API_PATHS.requestSourceStats({
      hours: DEFAULT_HOURS,
      bucketSec: DEFAULT_BUCKET_SEC,
      routeLimit: DEFAULT_ROUTE_LIMIT,
    }),
    CRON_1MIN,
  );
}
