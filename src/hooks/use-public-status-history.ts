"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { PublicStatusHistoryResponse, PublicStatusHistoryWindow } from "@shared/types";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { useRegisteredApiQuery } from "./api-hooks";

export function usePublicStatusHistory(
  window: PublicStatusHistoryWindow,
): UseQueryResult<PublicStatusHistoryResponse, Error> {
  return useRegisteredApiQuery<PublicStatusHistoryResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.publicStatusHistory(window),
    { retry: 1 },
  );
}
