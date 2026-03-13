"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { StatusResponse } from "@shared/types";
import { buildAdminApiPath, buildAdminFetchInit, getAdminQueryScope, type AdminAccess } from "@/lib/admin-access";
import { apiFetch } from "@/lib/api";
import { CRON_1MIN, usePollingQuery } from "./use-api-query";

/**
 * Fetches /api/status through the ops-host admin proxy.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(adminAccess: AdminAccess): UseQueryResult<StatusResponse, Error> {
  return usePollingQuery<StatusResponse>(
    ["status", getAdminQueryScope()],
    () => apiFetch<StatusResponse>(
      buildAdminApiPath("/api/status", adminAccess),
      undefined,
      buildAdminFetchInit(),
    ),
    CRON_1MIN,
    { enabled: true, retry: 0 },
  );
}
