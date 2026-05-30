"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS, buildQueryPath } from "@shared/lib/api-endpoints/paths";
import type { ApiKeySelfServeRequestAdminListResponse, ApiKeySelfServeStatus } from "@shared/types";
import { ApiKeySelfServeRequestAdminListResponseSchema } from "@shared/types/api-key-requests";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

interface ApiKeyRequestsOptions {
  status?: ApiKeySelfServeStatus;
  limit?: number;
}

export function useApiKeyRequests(
  options: ApiKeyRequestsOptions = {},
): UseQueryResult<ApiKeySelfServeRequestAdminListResponse, Error> {
  const limit = options.limit ?? 50;
  const path = buildQueryPath(API_PATHS.apiKeyRequestsAdmin(), {
    status: options.status,
    limit,
  });

  return useAdminPollingQuery<ApiKeySelfServeRequestAdminListResponse>(
    ["api-key-requests", options.status ?? "all", limit],
    path,
    CRON_1MIN,
    { schema: ApiKeySelfServeRequestAdminListResponseSchema },
  );
}
