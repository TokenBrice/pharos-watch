"use client";

import { useApiQuery, CRON_5MIN } from "./use-api-query";

export interface ChartPoint {
  date: number; // unix seconds
  totalCirculatingUSD: Record<string, number>;
}

export function useStablecoinCharts() {
  return useApiQuery<ChartPoint[]>(["stablecoin-charts"], "/api/stablecoin-charts", CRON_5MIN);
}
