"use client";

import { useApiQuery, CRON_15MIN } from "./use-api-query";

interface ChartPoint {
  date: number; // unix seconds
  totalCirculatingUSD: Record<string, number>;
}

export function useStablecoinCharts() {
  return useApiQuery<ChartPoint[]>(["stablecoin-charts"], "/api/stablecoin-charts", CRON_15MIN);
}
