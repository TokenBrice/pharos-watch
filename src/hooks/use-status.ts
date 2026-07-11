"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { StatusResponse } from "@shared/types";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { StatusResponseSchema } from "@shared/types/status";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

/**
 * Fetches /api/status through the ops-host admin proxy.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(options: { enabled?: boolean } = {}): UseQueryResult<StatusResponse, Error> {
  return useAdminPollingQuery<StatusResponse>(
    ["status"],
    API_PATHS.status(),
    CRON_1MIN,
    { enabled: options.enabled, schema: StatusResponseSchema },
  );
}
