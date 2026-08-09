"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { ADMIN_API_QUERY_DESCRIPTORS } from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export function useRequestSourceStats(
  options: { enabled?: boolean } = {},
): UseQueryResult<ApiRequestAttributionResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.requestSourceStats, options);
}
