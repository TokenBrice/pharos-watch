"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { ApiKeyListResponse } from "@shared/types";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

export function useApiKeys(): UseQueryResult<ApiKeyListResponse, Error> {
  return useAdminPollingQuery<ApiKeyListResponse>(
    ["api-keys"],
    API_PATHS.apiKeys(),
    CRON_1MIN,
  );
}
