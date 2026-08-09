"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiKeyListResponse } from "@shared/types";
import { ADMIN_API_QUERY_DESCRIPTORS } from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export function useApiKeys(): UseQueryResult<ApiKeyListResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.apiKeys);
}
