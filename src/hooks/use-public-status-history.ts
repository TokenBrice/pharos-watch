"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { PublicStatusHistoryResponse, PublicStatusHistoryWindow } from "@shared/types";
import { PublicStatusHistoryResponseSchema } from "@shared/types/status";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { useApiQuery } from "./use-api-query";

const HISTORY_RESULT_LIMIT = 200;

function buildPath(window: PublicStatusHistoryWindow): string {
  return API_PATHS.publicStatusHistory({ window, limit: HISTORY_RESULT_LIMIT });
}

export function usePublicStatusHistory(
  window: PublicStatusHistoryWindow,
): UseQueryResult<PublicStatusHistoryResponse, Error> {
  return useApiQuery<PublicStatusHistoryResponse>(
    ["public-status-history", window],
    buildPath(window),
    CRON_1MIN,
    { retry: 1, schema: PublicStatusHistoryResponseSchema },
  );
}
