"use client";

import { useMemo } from "react";
import { StablecoinListResponseSchema, type StablecoinListResponse } from "@shared/types";
import { useApiQuery, useApiQueryWithMeta, CRON_15MIN, CRON_1H } from "./use-api-query";
import type { ApiMeta } from "@/lib/api";

export interface SupplyHistoryPoint {
  date: number;
  circulatingUsd: number;
  price: number | null;
}

export function useStablecoins() {
  return useApiQuery<StablecoinListResponse>(
    ["stablecoins"], "/api/stablecoins", CRON_15MIN,
    { schema: StablecoinListResponseSchema },
  );
}

/** Meta-aware variant: returns { data, meta } with freshness info. */
export function useStablecoinsWithMeta() {
  const query = useApiQueryWithMeta<StablecoinListResponse>(
    ["stablecoins-meta"], "/api/stablecoins", CRON_15MIN,
    { schema: StablecoinListResponseSchema },
  );

  return {
    ...query,
    stablecoins: query.data?.data ?? undefined,
    meta: query.data?.meta ?? null,
  } as typeof query & { stablecoins: StablecoinListResponse | undefined; meta: ApiMeta | null };
}

/** Stablecoin detail shape (tokens array from DL, CG, or commodity paths) */
export interface DetailToken {
  date: number;
  totalCirculatingUSD?: Record<string, number>;
  totalCirculating?: Record<string, number>;
  circulating?: Record<string, number>;
}

export interface StablecoinDetail {
  tokens?: DetailToken[];
}

/** Sum all peg-type values in a circulating object (values are already in USD). */
function sumCirculating(obj: Record<string, number> | undefined): number {
  if (!obj) return 0;
  return Object.values(obj).reduce((s, v) => s + (v ?? 0), 0);
}

/** Transform detail tokens into SupplyHistoryPoint array. */
export function detailToSupplyHistory(detail: StablecoinDetail | undefined): SupplyHistoryPoint[] {
  if (!detail?.tokens) return [];
  return detail.tokens
    .map((t) => {
      const usd = sumCirculating(t.totalCirculatingUSD) || sumCirculating(t.circulating);
      return { date: t.date, circulatingUsd: usd, price: null as number | null };
    })
    .filter((d) => d.circulatingUsd > 0);
}

export function useSupplyHistory(id: string) {
  const query = useApiQuery<StablecoinDetail>(
    ["stablecoin-detail", id],
    `/api/stablecoin/${encodeURIComponent(id)}`,
    CRON_1H,
    { enabled: !!id }
  );

  const data = useMemo(() => detailToSupplyHistory(query.data), [query.data]);

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
