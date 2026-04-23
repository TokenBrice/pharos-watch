"use client";

import { useMemo } from "react";
import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { CRON_1H } from "@/lib/cron-intervals";
import { useApiQuery } from "@/hooks/use-api-query";
import { toSupplyHistoryPoints } from "@/lib/supply-history-points";
import type { SupplyHistoryPoint } from "@shared/types";

const StablecoinDetailHistoryResponseSchema = z.object({
  tokens: z.array(z.object({
    date: z.number(),
    totalCirculatingUSD: z.record(z.string(), z.number()).optional(),
  }).passthrough()),
});

export function useStablecoinDetailHistory(id: string) {
  const query = useApiQuery<z.infer<typeof StablecoinDetailHistoryResponseSchema>>(
    ["stablecoin-detail-history", id],
    API_PATHS.stablecoinDetail(id),
    CRON_1H,
    {
      enabled: !!id,
      schema: StablecoinDetailHistoryResponseSchema,
    },
  );

  const data = useMemo<SupplyHistoryPoint[]>(
    () => toSupplyHistoryPoints(query.data?.tokens ?? []),
    [query.data],
  );

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
