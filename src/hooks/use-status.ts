"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { StatusResponse } from "@shared/types";
import { CRON_1MIN, useAdminApiQuery } from "./use-api-query";

/**
 * Fetches /api/status with admin key auth.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(adminKey: string): UseQueryResult<StatusResponse, Error> {
  return useAdminApiQuery<StatusResponse>(
    ["status", adminKey],
    "/api/status",
    CRON_1MIN,
    { adminKey, retry: 0 },
  );
}
