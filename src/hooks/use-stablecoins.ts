"use client";

import { useMemo } from "react";
import type { StablecoinListResponse } from "@/lib/types";
import { useApiQuery, CRON_5MIN, CRON_1H } from "./use-api-query";

export interface SupplyHistoryPoint {
  date: number;
  circulatingUsd: number;
  price: number | null;
}

export function useStablecoins() {
  return useApiQuery<StablecoinListResponse>(["stablecoins"], "/api/stablecoins", CRON_5MIN);
}

/** DefiLlama stablecoin detail shape (tokens array) */
interface DetailToken {
  date: number;
  totalCirculatingUSD?: Record<string, number>;
  totalCirculating?: Record<string, number>;
  circulating?: Record<string, number>;
}

interface StablecoinDetail {
  tokens?: DetailToken[];
}

/** Sum all peg-type values in a circulating object (values are already in USD). */
function sumCirculating(obj: Record<string, number> | undefined): number {
  if (!obj) return 0;
  return Object.values(obj).reduce((s, v) => s + (v ?? 0), 0);
}

export function useSupplyHistory(id: string) {
  // Primary: our own supply_history table
  const primary = useApiQuery<SupplyHistoryPoint[]>(
    ["supply-history", id],
    `/api/supply-history?stablecoin=${encodeURIComponent(id)}&days=1825`,
    CRON_1H,
    { enabled: !!id }
  );

  // Fallback: DefiLlama detail proxy when supply_history is empty or too sparse
  // (commodity tokens like gold/silver aren't backfilled, so they may have only
  // a handful of daily snapshots instead of years of historical data)
  const needsFallback = primary.isSuccess && (!primary.data || primary.data.length < 30);
  const fallback = useApiQuery<StablecoinDetail>(
    ["stablecoin-detail", id],
    `/api/stablecoin/${encodeURIComponent(id)}`,
    CRON_1H,
    { enabled: !!id && needsFallback }
  );

  const fallbackData = useMemo(() => {
    if (!needsFallback || !fallback.data?.tokens) return undefined;
    return fallback.data.tokens
      .map((t) => {
        const usd = sumCirculating(t.totalCirculatingUSD) || sumCirculating(t.circulating);
        return { date: t.date, circulatingUsd: usd, price: null as number | null };
      })
      .filter((d) => d.circulatingUsd > 0);
  }, [needsFallback, fallback.data]);

  // Use fallback if it has more data than primary
  const useFallback = needsFallback && fallbackData && fallbackData.length > (primary.data?.length ?? 0);

  return {
    data: useFallback ? fallbackData : primary.data,
    isLoading: primary.isLoading || (needsFallback && fallback.isLoading),
    isError: useFallback ? fallback.isError : primary.isError,
  };
}
