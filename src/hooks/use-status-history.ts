"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { StatusHistoryResponse } from "@shared/types";
import { buildAdminApiPath, buildAdminFetchInit, getAdminQueryScope, type AdminAccess } from "@/lib/admin-access";
import { apiFetch } from "@/lib/api";
import { CRON_1MIN, usePollingQuery } from "./use-api-query";

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
  const params = new URLSearchParams({
    limit: "100",
    from: String(from),
  });
  return `/api/status-history?${params.toString()}`;
}

export function useStatusHistory(
  adminAccess: AdminAccess,
  window: StatusHistoryWindow,
): UseQueryResult<StatusHistoryResponse, Error> {
  return usePollingQuery<StatusHistoryResponse>(
    ["status-history", getAdminQueryScope(), window],
    () => apiFetch<StatusHistoryResponse>(
      buildAdminApiPath(buildStatusHistoryPath(window), adminAccess),
      undefined,
      buildAdminFetchInit(),
    ),
    CRON_1MIN,
    { enabled: true, retry: 0 },
  );
}
