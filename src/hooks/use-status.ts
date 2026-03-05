"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { ApiFetchError, apiFetch } from "@/lib/api";
import type { StatusResponse } from "@shared/types";
import { CRON_1MIN, usePollingQuery } from "./use-api-query";

/**
 * Fetches /api/status with admin key auth.
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useStatus(adminKey: string): UseQueryResult<StatusResponse, Error> {
  return usePollingQuery<StatusResponse>(
    ["status", adminKey],
    async () => {
      try {
        return await apiFetch<StatusResponse>(
          "/api/status",
          undefined,
          { headers: { "X-Admin-Key": adminKey } },
        );
      } catch (err) {
        if (err instanceof ApiFetchError && err.status === 401) {
          throw new Error("Invalid admin key");
        }
        throw err;
      }
    },
    CRON_1MIN,
    { enabled: !!adminKey, retry: 0 },
  );
}
