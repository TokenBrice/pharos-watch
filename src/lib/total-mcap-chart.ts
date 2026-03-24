import type { StablecoinChartPoint, SupplyHistoryPoint } from "@shared/types";

export interface TotalMcapChartRow {
  ts: number;
  usdt: number;
  usdc: number;
  sky: number;
  others: number;
  total: number;
}

function alignHistoryAtOrBeforeDate(
  chartPoints: StablecoinChartPoint[],
  history: SupplyHistoryPoint[],
): number[] {
  const sortedHistory = [...history].sort((a, b) => a.date - b.date);
  const aligned: number[] = [];
  let historyIndex = 0;
  let lastValue = 0;

  for (const point of chartPoints) {
    const chartDate = Number(point.date);
    while (historyIndex < sortedHistory.length && sortedHistory[historyIndex]!.date <= chartDate) {
      lastValue = sortedHistory[historyIndex]!.circulatingUsd;
      historyIndex += 1;
    }
    aligned.push(lastValue);
  }

  return aligned;
}

export function buildTotalMcapChartRows(
  chartPoints: StablecoinChartPoint[],
  {
    usdtHistory,
    usdcHistory,
    usdsHistory,
    daiHistory,
  }: {
    usdtHistory: SupplyHistoryPoint[];
    usdcHistory: SupplyHistoryPoint[];
    usdsHistory: SupplyHistoryPoint[];
    daiHistory: SupplyHistoryPoint[];
  },
): TotalMcapChartRow[] {
  if (chartPoints.length === 0) return [];

  const usdtSeries = alignHistoryAtOrBeforeDate(chartPoints, usdtHistory);
  const usdcSeries = alignHistoryAtOrBeforeDate(chartPoints, usdcHistory);
  const usdsSeries = alignHistoryAtOrBeforeDate(chartPoints, usdsHistory);
  const daiSeries = alignHistoryAtOrBeforeDate(chartPoints, daiHistory);

  return chartPoints.map((point, index) => {
    const total = Object.values(point.totalCirculatingUSD).reduce((sum, value) => sum + (value ?? 0), 0);
    const usdt = usdtSeries[index] ?? 0;
    const usdc = usdcSeries[index] ?? 0;
    const sky = (usdsSeries[index] ?? 0) + (daiSeries[index] ?? 0);
    const others = Math.max(0, total - usdt - usdc - sky);

    return {
      ts: Number(point.date) * 1000,
      usdt,
      usdc,
      sky,
      others,
      total,
    };
  });
}
