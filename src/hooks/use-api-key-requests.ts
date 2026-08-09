"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiKeySelfServeRequestAdminListResponse } from "@shared/types";
import {
  ADMIN_API_QUERY_DESCRIPTORS,
  type ApiKeyRequestsQueryOptions,
} from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export function useApiKeyRequests(
  options: ApiKeyRequestsQueryOptions = {},
): UseQueryResult<ApiKeySelfServeRequestAdminListResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeyRequests(options));
}
