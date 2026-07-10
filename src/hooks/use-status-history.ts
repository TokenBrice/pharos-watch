"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS, buildQueryPath } from "@shared/lib/api-endpoints/paths";
import type { StatusHistoryResponse } from "@shared/types";
import { StatusHistoryResponseSchema } from "@shared/types/status";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useAdminPollingQuery } from "./use-admin-polling-query";

export type StatusHistoryWindow = "6h" | "24h" | "7d" | "30d";

const WINDOW_TO_SECONDS: Record<StatusHistoryWindow, number> = {
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

function buildStatusHistoryPath(window: StatusHistoryWindow): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const from = nowSeconds - WINDOW_TO_SECONDS[window];
  return buildQueryPath(API_PATHS.statusHistoryBase(), {
    limit: 100,
    from,
  });
}

export function useStatusHistory(
  window: StatusHistoryWindow,
  options: { enabled?: boolean } = {},
): UseQueryResult<StatusHistoryResponse, Error> {
  return useAdminPollingQuery<StatusHistoryResponse>(
    ["status-history", window],
    () => buildStatusHistoryPath(window),
    CRON_1MIN,
    { enabled: options.enabled, schema: StatusHistoryResponseSchema },
  );
}
