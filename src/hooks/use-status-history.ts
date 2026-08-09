"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { StatusHistoryResponse } from "@shared/types";
import { ADMIN_API_QUERY_DESCRIPTORS, type StatusHistoryWindow } from "@/lib/admin-api-query-descriptors";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export type { StatusHistoryWindow };

export function useStatusHistory(
  window: StatusHistoryWindow,
  options: { enabled?: boolean } = {},
): UseQueryResult<StatusHistoryResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.statusHistory(window), options);
}
