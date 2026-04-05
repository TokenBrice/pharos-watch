"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { PublicStatusHistoryResponse } from "@shared/types";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useApiQuery } from "./use-api-query";

export type PublicHistoryWindow = "24h" | "7d" | "30d";

const WINDOW_TO_LIMIT: Record<PublicHistoryWindow, number> = {
  "24h": 20,
  "7d": 50,
  "30d": 50,
};

function buildPath(window: PublicHistoryWindow): string {
  return `/api/public-status-history?limit=${WINDOW_TO_LIMIT[window]}`;
}

export function usePublicStatusHistory(
  window: PublicHistoryWindow,
): UseQueryResult<PublicStatusHistoryResponse, Error> {
  return useApiQuery<PublicStatusHistoryResponse>(
    ["public-status-history", window],
    buildPath(window),
    CRON_1MIN,
    { retry: 1 },
  );
}
