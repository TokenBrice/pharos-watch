"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { ApiFetchError, apiFetch } from "@/lib/api";
import type { StatusHistoryResponse } from "@shared/types";
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
  adminKey: string,
  window: StatusHistoryWindow,
): UseQueryResult<StatusHistoryResponse, Error> {
  return usePollingQuery<StatusHistoryResponse>(
    ["status-history", adminKey, window],
    async () => {
      try {
        return await apiFetch<StatusHistoryResponse>(
          buildStatusHistoryPath(window),
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
