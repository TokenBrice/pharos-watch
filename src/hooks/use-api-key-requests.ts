"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { ApiKeySelfServeRequestAdminListResponse } from "@shared/types";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

export function useApiKeyRequests(): UseQueryResult<ApiKeySelfServeRequestAdminListResponse, Error> {
  return useAdminPollingQuery<ApiKeySelfServeRequestAdminListResponse>(
    ["api-key-requests"],
    API_PATHS.apiKeyRequestsAdmin(),
    CRON_1MIN,
  );
}
