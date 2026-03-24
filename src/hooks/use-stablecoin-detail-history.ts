"use client";

import { useMemo } from "react";
import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { CRON_1H } from "@/lib/cron-intervals";
import { useApiQuery } from "@/hooks/use-api-query";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

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

  const data = useMemo<SupplyHistoryPoint[]>(() => {
    const tokens = query.data?.tokens ?? [];
    return tokens
      .map((token) => ({
        date: token.date,
        circulatingUsd: Object.values(token.totalCirculatingUSD ?? {}).reduce((sum, value) => sum + (value ?? 0), 0),
        price: null,
      }))
      .filter((point) => Number.isFinite(point.date) && point.circulatingUsd > 0)
      .sort((a, b) => a.date - b.date);
  }, [query.data]);

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
