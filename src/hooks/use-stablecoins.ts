"use client";

import { useMemo } from "react";
import type { StablecoinListResponse } from "@/lib/types";
import { useApiQuery, CRON_15MIN, CRON_1H } from "./use-api-query";

export interface SupplyHistoryPoint {
  date: number;
  circulatingUsd: number;
  price: number | null;
}

export function useStablecoins() {
  return useApiQuery<StablecoinListResponse>(["stablecoins"], "/api/stablecoins", CRON_15MIN);
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

export interface PriceHistoryPoint {
  date: number;       // epoch seconds
  price: number;      // USD price
}

/** Extract historical prices from detail tokens. Price = totalCirculatingUSD / totalCirculating. */
export function detailToPriceHistory(detail: StablecoinDetail | undefined): PriceHistoryPoint[] {
  if (!detail?.tokens) return [];
  return detail.tokens
    .map((t) => {
      const usd = sumCirculating(t.totalCirculatingUSD) || sumCirculating(t.circulating);
      const native = sumCirculating(t.totalCirculating);
      if (usd <= 0 || native <= 0) return null;
      return { date: t.date, price: usd / native };
    })
    .filter((d): d is PriceHistoryPoint => d !== null);
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
  };
}
