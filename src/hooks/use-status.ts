"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { StatusResponse } from "@shared/types";
import type { AdminAccess } from "@/lib/admin-access";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

/**
 * Fetches /api/status through the ops-host admin proxy.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(adminAccess: AdminAccess): UseQueryResult<StatusResponse, Error> {
  return useAdminPollingQuery<StatusResponse>(adminAccess, ["status"], "/api/status", CRON_1MIN);
}
