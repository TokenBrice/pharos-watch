"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { StatusResponse } from "@shared/types";
import { ADMIN_API_QUERY_DESCRIPTORS } from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

/**
 * Fetches /api/status through the ops-host admin proxy.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(options: { enabled?: boolean } = {}): UseQueryResult<StatusResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.status, options);
}
