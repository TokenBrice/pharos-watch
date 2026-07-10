"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { ApiRequestAttributionResponseSchema } from "@shared/types/request-source";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

const DEFAULT_HOURS = 24;
const DEFAULT_BUCKET_SEC = 3600;
const DEFAULT_ROUTE_LIMIT = 5;
const DEFAULT_API_KEY_LIMIT = 25;

export function useRequestSourceStats(
  options: { enabled?: boolean } = {},
): UseQueryResult<ApiRequestAttributionResponse, Error> {
  return useAdminPollingQuery<ApiRequestAttributionResponse>(
    ["request-source-stats", DEFAULT_HOURS, DEFAULT_BUCKET_SEC, DEFAULT_ROUTE_LIMIT, DEFAULT_API_KEY_LIMIT],
    API_PATHS.requestSourceStats({
      hours: DEFAULT_HOURS,
      bucketSec: DEFAULT_BUCKET_SEC,
      routeLimit: DEFAULT_ROUTE_LIMIT,
      apiKeyLimit: DEFAULT_API_KEY_LIMIT,
    }),
    CRON_1MIN,
    { enabled: options.enabled, schema: ApiRequestAttributionResponseSchema },
  );
}
